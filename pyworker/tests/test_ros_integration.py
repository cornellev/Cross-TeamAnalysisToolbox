"""Needs ROS Humble (rosbag2_py). Writes a REAL rosbag2 and reads it through the production reader, so
the opaque-fallback path is exercised against the real deserializer. Skipped where ROS is absent."""

import json

import pytest

rosbag2_py = pytest.importorskip("rosbag2_py")

import cache_core as core  # noqa: E402
from cache_job import RosbagReader  # noqa: E402
from tests.test_cache_core import MemorySink  # noqa: E402


def _write_bag(folder, items):
    """items: [(topic, type_name, serialized_bytes, t_ns)]"""
    writer = rosbag2_py.SequentialWriter()
    writer.open(rosbag2_py.StorageOptions(uri=str(folder), storage_id="sqlite3"),
                rosbag2_py.ConverterOptions("", ""))
    seen = set()
    for topic, type_name, _data, _t in items:
        if topic not in seen:
            writer.create_topic(rosbag2_py.TopicMetadata(name=topic, type=type_name, serialization_format="cdr"))
            seen.add(topic)
    for topic, _type, data, t in items:
        writer.write(topic, data, t)
    del writer


def _cdr_string(text):
    import struct
    body = text.encode() + b"\x00"
    return b"\x00\x01\x00\x00" + struct.pack("<I", len(body)) + body


def test_a_real_bag_with_a_known_and_an_uninstallable_type(tmp_path):
    folder = tmp_path / "bag"
    _write_bag(folder, [
        ("/chatter", "std_msgs/msg/String", _cdr_string("hello"), 1_000_000_000),
        ("/team", "not_installed_pkgs/msg/Thing", b"\x00\x01\x00\x00\xde\xad\xbe\xef", 2_000_000_000),
        ("/chatter", "std_msgs/msg/String", _cdr_string("world"), 3_000_000_000),
    ])
    files = core.resolve_files(tmp_path, ["bag/bag_0.db3", "bag/metadata.yaml"])
    sink = MemorySink()

    out = core.build_bag("rec-real", RosbagReader(core.bag_uri(files)), sink,
                         yaml_text=(folder / "metadata.yaml").read_text())

    assert out["messages"] == 3 and out["opaque_topics"] == ["/team"]
    rows = [(m[1], m[2], json.loads(m[3])) for m in sink.messages]
    assert rows[0] == ("/chatter", 1_000_000_000, {"data": "hello"})
    assert rows[1][0] == "/team" and rows[1][2]["_opaque"] is True and rows[1][2]["type"] == "not_installed_pkgs/msg/Thing"
    assert rows[2][2] == {"data": "world"}
    by = {t["name"]: t for t in out["topics"]}
    assert by["/chatter"]["decoded"] is True and by["/team"]["decoded"] is False


def test_a_single_db3_path_also_opens(tmp_path):
    folder = tmp_path / "bag"
    _write_bag(folder, [("/chatter", "std_msgs/msg/String", _cdr_string("solo"), 1)])
    only_db3 = core.resolve_files(tmp_path, ["bag/bag_0.db3"])
    out = core.build_bag("r", RosbagReader(core.bag_uri(only_db3)), MemorySink())
    assert out["messages"] == 1
