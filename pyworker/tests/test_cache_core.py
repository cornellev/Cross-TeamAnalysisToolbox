"""cache_core has no ROS or Postgres imports, so this runs anywhere: an in-memory sink and a fake
bag reader stand in for them."""

import base64
import json

import pytest

import cache_core as core


class MemorySink:
    def __init__(self):
        self.messages, self.begun, self.topics, self.csv, self.deleted = [], [], None, None, []

    def begin_bag(self, recording_id, yaml_text):
        self.messages = [m for m in self.messages if m[0] != recording_id]      # idempotent rebuild
        self.begun.append((recording_id, yaml_text))

    def add_messages(self, recording_id, rows):
        self.messages += [(recording_id, *r) for r in rows]

    def finish_bag(self, recording_id, topics):
        self.topics = topics
        return {"bytes": sum(len(m[3]) for m in self.messages if m[0] == recording_id)}

    def put_csv(self, recording_id, headers, rows):
        self.csv = (recording_id, headers, rows)
        return {"bytes": len(json.dumps(rows))}

    def delete(self, recording_id, kind):
        self.deleted.append((recording_id, kind))
        return 1


class Msg:
    __slots__ = ("_x", "_label", "nested", "arr")

    def __init__(self, x, label):
        self._x, self._label = x, label
        self.nested = Inner()
        self.arr = [1, 2]


class Inner:
    __slots__ = ("_a",)

    def __init__(self):
        self._a = 7


class FakeReader:
    def __init__(self, items, types, decodable):
        self.items, self._types, self.decodable = items, types, decodable

    def topics(self):
        return self._types

    def total_messages(self):
        return len(self.items)

    def messages(self):
        yield from self.items

    def decoder(self, topic_type):
        if topic_type not in self.decodable:
            return None
        return lambda data: Msg(data[0], data.decode()[1:])


# ---- paths ----------------------------------------------------------------------------

def test_resolve_files_stays_inside_the_store(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "bag.db3").write_bytes(b"x")
    (tmp_path / "secret.txt").write_text("nope")
    assert core.resolve_files(tmp_path, ["a/bag.db3"]) == [(tmp_path / "a" / "bag.db3").resolve()]
    for bad in ("../secret.txt", "/etc/passwd", "a/../../secret.txt", "", "a/missing.db3", "a/bag.db3\x00"):
        with pytest.raises(core.CacheError):
            core.resolve_files(tmp_path, [bad])
    with pytest.raises(core.CacheError):
        core.resolve_files(tmp_path, [])


def test_a_symlink_out_of_the_store_is_refused(tmp_path):
    outside = tmp_path.parent / "outside_target.db3"
    outside.write_bytes(b"x")
    store = tmp_path / "store"
    store.mkdir()
    (store / "link.db3").symlink_to(outside)
    with pytest.raises(core.CacheError):
        core.resolve_files(store, ["link.db3"])


def test_bag_uri_prefers_the_directory_for_split_bags(tmp_path):
    folder = tmp_path / "bag"
    folder.mkdir()
    db3 = folder / "bag_0.db3"
    meta = folder / "metadata.yaml"
    db3.write_bytes(b"x")
    meta.write_text("x: 1")
    assert core.bag_uri([db3, meta]) == str(folder)
    assert core.bag_uri([db3]) == str(db3)
    with pytest.raises(core.CacheError):
        core.bag_uri([meta])


# ---- building ---------------------------------------------------------------------------

def test_decodable_messages_are_stored_as_json_under_the_recording_id():
    reader = FakeReader([("/a", 1, b"5hello"), ("/a", 2, b"6world")], {"/a": "pkg/msg/Known"}, {"pkg/msg/Known"})
    sink = MemorySink()

    out = core.build_bag("rec1", reader, sink, yaml_text="k: v")

    assert out["messages"] == 2 and out["opaque_topics"] == [] and out["bytes"] > 0
    assert sink.begun == [("rec1", "k: v")]
    first = json.loads(sink.messages[0][3])
    assert first == {"x": 53, "label": "hello", "nested": {"a": 7}, "arr": [1, 2]}      # leading underscores stripped
    assert [m[:3] for m in sink.messages] == [("rec1", "/a", 1), ("rec1", "/a", 2)]
    assert out["topics"] == [{"name": "/a", "type": "pkg/msg/Known", "count": 2, "decoded": True, "opaque_count": 0}]


def test_an_unknown_message_type_is_stored_opaque_not_fatal():
    reader = FakeReader([("/known", 1, b"1ok"), ("/odd", 2, b"\x00\x01\x02\x03"), ("/odd", 3, b"\x04"), ("/known", 4, b"2ok")],
                        {"/known": "pkg/msg/Known", "/odd": "weird/msg/Thing"}, {"pkg/msg/Known"})
    sink = MemorySink()

    out = core.build_bag("rec", reader, sink)

    assert out["messages"] == 4 and out["opaque_topics"] == ["/odd"]
    odd = [json.loads(m[3]) for m in sink.messages if m[1] == "/odd"]
    assert odd[0] == {"_opaque": True, "type": "weird/msg/Thing", "encoding": "cdr", "size": 4,
                      "cdr_base64": base64.b64encode(b"\x00\x01\x02\x03").decode()}
    assert base64.b64decode(odd[1]["cdr_base64"]) == b"\x04"                        # nothing is dropped
    assert [m[1] for m in sink.messages] == ["/known", "/odd", "/odd", "/known"]      # time order kept
    by = {t["name"]: t for t in out["topics"]}
    assert by["/odd"]["decoded"] is False and by["/odd"]["opaque_count"] == 2 and by["/known"]["decoded"] is True


def test_a_message_that_fails_to_decode_is_opaque_too():
    class Boom(FakeReader):
        def decoder(self, topic_type):
            def decode(data):
                if data == b"bad":
                    raise ValueError("corrupt CDR")
                return Msg(data[0], "ok")
            return decode

    reader = Boom([("/a", 1, b"1ok"), ("/a", 2, b"bad")], {"/a": "pkg/msg/Known"}, set())
    out = core.build_bag("rec", reader, MemorySink())
    assert out["messages"] == 2 and out["topics"][0]["opaque_count"] == 1 and out["opaque_topics"] == ["/a"]


def test_batches_flush_by_count_and_by_size_and_progress_is_reported(tmp_path):
    items = [("/a", i, b"1" + b"x" * 50) for i in range(25)]
    reader = FakeReader(items, {"/a": "pkg/msg/Known"}, {"pkg/msg/Known"})

    class CountingSink(MemorySink):
        def __init__(self):
            super().__init__()
            self.batches = []

        def add_messages(self, recording_id, rows):
            self.batches.append(len(rows))
            super().add_messages(recording_id, rows)

    sink = CountingSink()
    progress = core.Progress("rec/with:odd chars", directory=tmp_path)
    core.build_bag("rec", reader, sink, progress=progress, batch_size=10, batch_bytes=0)
    assert sink.batches == [10, 10, 5]
    assert core.Progress.read("rec/with:odd chars", directory=tmp_path)["fraction"] == 1.0

    by_size = CountingSink()
    core.build_bag("rec", reader, by_size, batch_size=1000, batch_bytes=500)
    assert len(by_size.batches) > 1 and sum(by_size.batches) == 25


def test_a_rebuild_replaces_it_does_not_duplicate():
    reader = FakeReader([("/a", 1, b"1x")], {"/a": "pkg/msg/Known"}, {"pkg/msg/Known"})
    sink = MemorySink()
    core.build_bag("rec", reader, sink)
    core.build_bag("rec", reader, sink)
    assert len(sink.messages) == 1


def test_unserializable_message_fields_are_encoded_not_fatal():
    import array

    class Weird:
        __slots__ = ("data", "raw", "obj")

        def __init__(self):
            self.data = array.array("B", [1, 2, 3])
            self.raw = b"\xff\x00"
            self.obj = object()

    out = json.loads(core.encode_message(Weird()))
    assert out["data"] == [1, 2, 3] and out["raw"] == {"_bytes_b64": "/wA="} and isinstance(out["obj"], str)


def test_csv_rows_are_cached_as_strings_like_cat_always_stored_them(tmp_path):
    path = tmp_path / "x.csv"
    path.write_text("a,b\n1,2.5\n3,\n")
    sink = MemorySink()
    out = core.build_csv("rec", path, sink)
    assert sink.csv == ("rec", ["a", "b"], [{"a": "1", "b": "2.5"}, {"a": "3", "b": ""}]) and out["messages"] == 2
    empty = tmp_path / "e.csv"
    empty.write_text("a,b\n")
    with pytest.raises(core.CacheError):
        core.build_csv("rec", empty, sink)


def test_progress_file_roundtrip_and_missing(tmp_path):
    p = core.Progress("r1", directory=tmp_path)
    assert core.Progress.read("r1", directory=tmp_path) is None
    p.update(0.5, 10)
    assert core.Progress.read("r1", directory=tmp_path)["fraction"] == 0.5
    p.clear()
    assert core.Progress.read("r1", directory=tmp_path) is None


def test_extra_message_packages_become_importable_without_a_rebuild(tmp_path):
    from cache_job import extra_environment

    pkg = tmp_path / "install" / "team_msgs"
    (pkg / "lib" / "python3.10" / "site-packages").mkdir(parents=True)
    env = extra_environment(str(tmp_path), {"PYTHONPATH": "/base"})
    assert env["PYTHONPATH"].startswith(str(pkg / "lib" / "python3.10" / "site-packages")) and env["PYTHONPATH"].endswith("/base")
    assert str(pkg) in env["AMENT_PREFIX_PATH"].split(":")
    assert extra_environment(str(tmp_path / "none"), {"PYTHONPATH": "/base"}) == {"PYTHONPATH": "/base"}
