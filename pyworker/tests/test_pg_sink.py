"""Needs a real Postgres: set CAT_TEST_PG=host:port:user:password:dbname (the docker-based run in
the CAT README does). Skipped otherwise."""

import json
import os

import pytest

psycopg2 = pytest.importorskip("psycopg2")
spec = os.getenv("CAT_TEST_PG")
pytestmark = pytest.mark.skipif(not spec, reason="CAT_TEST_PG not set")

import cache_core as core  # noqa: E402


@pytest.fixture
def sink():
    from cache_sink import PostgresSink

    host, port, user, password, dbname = spec.split(":")
    conn = psycopg2.connect(host=host, port=int(port), user=user, password=password, dbname=dbname)
    with conn, conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS rosbag_messages, rosbags, csv_uploads, cache_topics CASCADE")
    s = PostgresSink(conn)
    yield s
    conn.close()


def _count(sink, sql, *args):
    with sink.conn, sink.conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()[0]


def test_schema_creation_is_idempotent_and_adds_cache_topics_to_an_old_database(sink):
    from cache_sink import PostgresSink

    with sink.conn, sink.conn.cursor() as cur:
        cur.execute("DROP TABLE cache_topics")          # a database from before Phase 4
    PostgresSink(sink.conn)
    PostgresSink(sink.conn)
    assert _count(sink, "SELECT COUNT(*) FROM cache_topics") == 0


def test_a_bag_is_stored_measured_and_deleted(sink):
    sink.begin_bag("rec1", "rosbag2_bagfile_information:\n  version: 5\n")
    sink.add_messages("rec1", [("/a", 1, json.dumps({"x": 1})), ("/a", 2, json.dumps({"x": 2})), ("/b", 3, core.opaque_message("t/msg/T", b"\x01\x02"))])
    out = sink.finish_bag("rec1", [{"name": "/a", "type": "p/msg/A", "count": 2, "decoded": True},
                                   {"name": "/b", "type": "t/msg/T", "count": 1, "decoded": False}])

    assert out["bytes"] > 0
    assert _count(sink, "SELECT COUNT(*) FROM rosbag_messages WHERE bag_name = %s", "rec1") == 3
    assert _count(sink, "SELECT yaml_data->'rosbag2_bagfile_information'->>'version' FROM rosbags WHERE folder_name = %s", "rec1") == "5"
    assert _count(sink, "SELECT COUNT(*) FROM cache_topics WHERE bag_name = %s AND decoded = FALSE", "rec1") == 1
    assert _count(sink, "SELECT data->>'_opaque' FROM rosbag_messages WHERE topic = '/b'") == "true"

    assert sink.delete("rec1", "bag") == 3
    for table, col in (("rosbag_messages", "bag_name"), ("cache_topics", "bag_name"), ("rosbags", "folder_name")):
        assert _count(sink, f"SELECT COUNT(*) FROM {table} WHERE {col} = %s", "rec1") == 0


def test_a_rebuild_replaces_and_other_recordings_are_untouched(sink):
    for rid in ("a", "b"):
        sink.begin_bag(rid, None)
        sink.add_messages(rid, [("/t", 1, "{}"), ("/t", 2, "{}")])
        sink.finish_bag(rid, [{"name": "/t", "type": "x", "count": 2, "decoded": True}])
    sink.begin_bag("a", None)
    sink.add_messages("a", [("/t", 9, "{}")])
    sink.finish_bag("a", [{"name": "/t", "type": "x", "count": 1, "decoded": True}])
    assert _count(sink, "SELECT COUNT(*) FROM rosbag_messages WHERE bag_name = 'a'") == 1
    assert _count(sink, "SELECT COUNT(*) FROM rosbag_messages WHERE bag_name = 'b'") == 2
    assert _count(sink, "SELECT COUNT(*) FROM rosbags") == 2


def test_csv_upsert_and_delete(sink):
    sink.put_csv("c1", ["a", "b"], [{"a": "1", "b": "2"}])
    sink.put_csv("c1", ["a", "b"], [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}])
    assert _count(sink, "SELECT jsonb_array_length(data) FROM csv_uploads WHERE name = 'c1'") == 2
    assert _count(sink, "SELECT COUNT(*) FROM csv_uploads") == 1
    assert sink.delete("c1", "csv") == 1
    assert _count(sink, "SELECT COUNT(*) FROM csv_uploads") == 0


def test_the_existing_cat_queries_still_work_on_cached_rows(sink):
    """The Node server's reads (paged by timestamp, topics) are unchanged: same table, same columns."""
    sink.begin_bag("rec", None)
    sink.add_messages("rec", [("/a", t, json.dumps({"n": t})) for t in (5, 1, 3)])
    sink.finish_bag("rec", [{"name": "/a", "type": "x", "count": 3, "decoded": True}])
    with sink.conn, sink.conn.cursor() as cur:
        cur.execute("SELECT timestamp, data::text FROM rosbag_messages WHERE bag_name = %s AND timestamp > %s ORDER BY timestamp ASC LIMIT 2", ("rec", 1))
        assert [r[0] for r in cur.fetchall()] == [3, 5]
        cur.execute("SELECT DISTINCT topic FROM rosbag_messages WHERE bag_name = %s", ("rec",))
        assert [r[0] for r in cur.fetchall()] == ["/a"]
