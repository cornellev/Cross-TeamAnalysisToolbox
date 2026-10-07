"""Postgres sink for cache_core: writes CAT's cache tables, keyed by EVIL's recording_id."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime

DB_HOST = os.getenv("DB_HOST", "db")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "mypass")
DB_NAME = os.getenv("DB_NAME", "cat_db")
DB_PORT = int(os.getenv("DB_PORT", "5432"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS rosbag_messages (
    id SERIAL PRIMARY KEY, bag_name TEXT NOT NULL, topic TEXT NOT NULL,
    timestamp BIGINT NOT NULL, data JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rosbag_bag ON rosbag_messages(bag_name);
CREATE INDEX IF NOT EXISTS idx_rosbag_time ON rosbag_messages(timestamp);
CREATE TABLE IF NOT EXISTS rosbags (
    id SERIAL PRIMARY KEY, folder_name TEXT NOT NULL UNIQUE, yaml_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS csv_uploads (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, headers TEXT[] NOT NULL, data JSONB NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
-- Phase 4: which topics of a cached bag were stored undecoded (type not installed here)
CREATE TABLE IF NOT EXISTS cache_topics (
    bag_name TEXT NOT NULL, topic TEXT NOT NULL, type TEXT, msg_count BIGINT,
    decoded BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (bag_name, topic));
"""


def connect(retries: int = 10):
    import psycopg2

    last = None
    for _ in range(retries):
        try:
            return psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT)
        except psycopg2.OperationalError as exc:
            last = exc
            time.sleep(2)
    raise RuntimeError(f"cannot reach Postgres: {last}")


class PostgresSink:
    def __init__(self, conn=None):
        self.conn = conn or connect()
        with self.conn, self.conn.cursor() as cur:
            cur.execute(SCHEMA)          # idempotent: an existing NUC database predates cache_topics

    # -- bags
    def begin_bag(self, recording_id: str, yaml_text: str | None) -> None:
        import yaml

        yaml_data = None
        if yaml_text:
            try:
                yaml_data = yaml.safe_load(yaml_text)
            except Exception:
                yaml_data = {"raw": yaml_text}
        with self.conn, self.conn.cursor() as cur:
            self._delete_bag(cur, recording_id)           # a rebuild replaces, never duplicates
            cur.execute("INSERT INTO rosbags (folder_name, yaml_data, created_at) VALUES (%s, %s, %s)",
                        (recording_id, json.dumps(yaml_data) if yaml_data else None, datetime.utcnow()))

    def add_messages(self, recording_id: str, rows: list[tuple[str, int, str]]) -> None:
        from psycopg2.extras import execute_values

        with self.conn, self.conn.cursor() as cur:
            execute_values(cur, "INSERT INTO rosbag_messages (bag_name, topic, timestamp, data) VALUES %s",
                           [(recording_id, topic, t, data) for topic, t, data in rows], template="(%s, %s, %s, %s::jsonb)")

    def finish_bag(self, recording_id: str, topics: list[dict]) -> dict:
        with self.conn, self.conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO cache_topics (bag_name, topic, type, msg_count, decoded) VALUES (%s, %s, %s, %s, %s)",
                [(recording_id, t["name"], t["type"], t["count"], t["decoded"]) for t in topics])
            cur.execute("SELECT COALESCE(SUM(octet_length(data::text)), 0) FROM rosbag_messages WHERE bag_name = %s",
                        (recording_id,))
            return {"bytes": int(cur.fetchone()[0])}

    # -- csv
    def put_csv(self, recording_id: str, headers: list[str], rows: list[dict]) -> dict:
        payload = json.dumps(rows)
        with self.conn, self.conn.cursor() as cur:
            cur.execute(
                """INSERT INTO csv_uploads (name, headers, data) VALUES (%s, %s, %s::jsonb)
                   ON CONFLICT (name) DO UPDATE SET headers = EXCLUDED.headers, data = EXCLUDED.data,
                       uploaded_at = NOW()""", (recording_id, headers, payload))
        return {"bytes": len(payload)}

    # -- eviction
    def _delete_bag(self, cur, recording_id: str) -> int:
        cur.execute("DELETE FROM rosbag_messages WHERE bag_name = %s", (recording_id,))
        n = cur.rowcount
        cur.execute("DELETE FROM cache_topics WHERE bag_name = %s", (recording_id,))
        cur.execute("DELETE FROM rosbags WHERE folder_name = %s", (recording_id,))
        return n

    def delete(self, recording_id: str, kind: str) -> int:
        with self.conn, self.conn.cursor() as cur:
            if kind == "csv":
                cur.execute("DELETE FROM csv_uploads WHERE name = %s", (recording_id,))
                return cur.rowcount
            return self._delete_bag(cur, recording_id)
