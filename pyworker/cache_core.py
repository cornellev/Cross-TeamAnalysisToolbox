"""Builds CAT's derived cache from a recording that EVIL stores.

CAT's database is a CACHE now, not a source of truth: EVIL keeps the original file (and the
catalog that says what it is); this module decodes a recording into CAT's Postgres keyed by the
EVIL `recording_id` (rosbag_messages.bag_name, rosbags.folder_name and csv_uploads.name all hold
the recording id, so every existing CAT query keeps working) and can drop it again.

This file is deliberately free of ROS and Postgres imports so its logic can be tested anywhere:
the ROS side (rosbag2_py / rclpy) lives in cache_job.py and the Postgres side in PostgresSink.

Any bag stays readable: a message whose type cannot be imported (a team package that is not
installed in this image) is stored OPAQUE -- topic, time and the raw CDR bytes as base64 --
instead of aborting the whole bag. The topic is flagged "not decoded" so the UI can say so, and
nothing is lost: a later build with the package installed decodes it.
"""

from __future__ import annotations

import array
import base64
import csv
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Protocol

BATCH_SIZE = int(os.getenv("PYWORKER_BATCH_SIZE", "500"))
BATCH_BYTES = int(os.getenv("PYWORKER_BATCH_BYTES", str(10 * 1024 * 1024)))
PROGRESS_DIR = Path(os.getenv("CACHE_PROGRESS_DIR", "/tmp/cat-cache-progress"))


class CacheError(Exception):
    """A build cannot proceed (bad path, missing files...). The message is shown to users."""


# ---- paths ---------------------------------------------------------------------

def resolve_files(raw_root: str | Path, rel_paths: Iterable[str]) -> list[Path]:
    """EVIL sends paths relative to the raw store; refuse anything that escapes it."""
    root = Path(raw_root).resolve()
    out: list[Path] = []
    for rel in rel_paths:
        if not rel or rel.startswith("/") or "\x00" in rel:
            raise CacheError(f"invalid file path {rel!r}")
        path = (root / rel).resolve()
        if not path.is_relative_to(root):
            raise CacheError(f"path escapes the recording store: {rel!r}")
        if not path.is_file():
            raise CacheError(f"file not found in the recording store: {rel}")
        out.append(path)
    if not out:
        raise CacheError("no files to read")
    return out


def bag_uri(paths: list[Path]) -> str:
    """What rosbag2 should open: the bag directory when it has metadata.yaml (split bags),
    else the single .db3 file."""
    db3s = sorted(p for p in paths if p.suffix == ".db3")
    if not db3s:
        raise CacheError("no .db3 file in this recording")
    folder = db3s[0].parent
    if any(p.name == "metadata.yaml" and p.parent == folder for p in paths):
        return str(folder)
    return str(db3s[0])


# ---- message -> JSON -------------------------------------------------------------

def _clean_key(name: Any) -> Any:
    return name.lstrip("_") if isinstance(name, str) else name


def msg_to_dict(msg: Any) -> Any:
    """ROS message object -> plain JSON-able structure (same shape CAT always stored)."""
    if hasattr(msg, "__slots__"):
        return {_clean_key(slot): msg_to_dict(getattr(msg, slot)) for slot in msg.__slots__}
    if isinstance(msg, (list, tuple)):
        return [msg_to_dict(v) for v in msg]
    if isinstance(msg, dict):
        return {k: msg_to_dict(v) for k, v in msg.items()}
    return msg


class MessageEncoder(json.JSONEncoder):
    def default(self, obj: Any) -> Any:
        if hasattr(obj, "tolist"):                 # numpy arrays / scalars
            return obj.tolist()
        if isinstance(obj, array.array):
            return list(obj)
        if isinstance(obj, (bytes, bytearray, memoryview)):
            return {"_bytes_b64": base64.b64encode(bytes(obj)).decode()}
        return str(obj)                            # PointField and other message objects


def encode_message(msg: Any) -> str:
    return json.dumps(msg_to_dict(msg), cls=MessageEncoder)


def opaque_message(topic_type: str, data: bytes) -> str:
    """A message we cannot decode: keep the raw CDR so nothing is dropped."""
    return json.dumps({"_opaque": True, "type": topic_type, "encoding": "cdr",
                       "size": len(data), "cdr_base64": base64.b64encode(bytes(data)).decode()})


# ---- progress ---------------------------------------------------------------------

class Progress:
    """Written by the build subprocess, read by the API (GET /cache/progress/<id>)."""

    def __init__(self, recording_id: str, directory: Path = PROGRESS_DIR):
        self.path = Path(directory) / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', recording_id)}.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def update(self, fraction: float, messages: int) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fraction": round(min(max(fraction, 0.0), 1.0), 4), "messages": messages,
                                   "updated": time.time()}))
        os.replace(tmp, self.path)

    @staticmethod
    def read(recording_id: str, directory: Path = PROGRESS_DIR) -> dict | None:
        path = Path(directory) / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', recording_id)}.json"
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return None

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


# ---- the storage seam ----------------------------------------------------------------

class Sink(Protocol):
    def begin_bag(self, recording_id: str, yaml_text: str | None) -> None: ...
    def add_messages(self, recording_id: str, rows: list[tuple[str, int, str]]) -> None: ...
    def finish_bag(self, recording_id: str, topics: list[dict]) -> dict: ...
    def put_csv(self, recording_id: str, headers: list[str], rows: list[dict]) -> dict: ...
    def delete(self, recording_id: str, kind: str) -> int: ...


class BagReader(Protocol):
    def topics(self) -> dict[str, str]: ...                       # topic name -> type
    def messages(self) -> Iterator[tuple[str, int, bytes]]: ...   # (topic, timestamp_ns, cdr bytes)
    def total_messages(self) -> int | None: ...
    def decoder(self, topic_type: str) -> Callable[[bytes], Any] | None: ...   # None = cannot decode


# ---- builds --------------------------------------------------------------------------

def build_bag(recording_id: str, reader: BagReader, sink: Sink, *, yaml_text: str | None = None,
              progress: Progress | None = None, batch_size: int = BATCH_SIZE,
              batch_bytes: int = BATCH_BYTES) -> dict:
    """Decode every message into the sink (opaque where it cannot be decoded). Idempotent: a rebuild
    replaces what the recording had. Returns {messages, bytes, topics, opaque_topics}."""
    types = reader.topics()
    decoders: dict[str, Callable[[bytes], Any] | None] = {}
    stats: dict[str, dict] = {t: {"name": t, "type": ty, "count": 0, "decoded": True, "opaque_count": 0}
                              for t, ty in types.items()}
    total = reader.total_messages()
    sink.begin_bag(recording_id, yaml_text)

    batch: list[tuple[str, int, str]] = []
    size = seen = 0

    def flush() -> None:
        nonlocal batch, size
        if batch:
            sink.add_messages(recording_id, batch)
            batch, size = [], 0

    for topic, t, data in reader.messages():
        ty = types.get(topic, "")
        if ty not in decoders:
            decoders[ty] = reader.decoder(ty)
        decode = decoders[ty]
        text = None
        if decode is not None:
            try:
                text = encode_message(decode(data))
            except Exception:                       # a message that fails to decode is opaque too
                text = None
        st = stats.setdefault(topic, {"name": topic, "type": ty, "count": 0, "decoded": True, "opaque_count": 0})
        if text is None:
            text = opaque_message(ty, data)
            st["decoded"] = False
            st["opaque_count"] += 1
        st["count"] += 1
        batch.append((topic, t, text))
        size += len(text)
        seen += 1
        if len(batch) >= max(1, batch_size) or (batch_bytes and size >= batch_bytes):
            flush()
            if progress and total:
                progress.update(seen / total, seen)
    flush()
    topics = sorted(stats.values(), key=lambda s: s["name"])
    result = sink.finish_bag(recording_id, topics)
    if progress:
        progress.update(1.0, seen)
    return {"messages": seen, "bytes": result.get("bytes", 0), "topics": topics,
            "opaque_topics": [s["name"] for s in topics if not s["decoded"]]}


def read_csv_rows(path: Path) -> tuple[list[str], list[dict]]:
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        headers = list(reader.fieldnames or [])
        rows = [dict(r) for r in reader]
    if not headers or not rows:
        raise CacheError("CSV is empty or has no header row")
    return headers, rows


def build_csv(recording_id: str, path: Path, sink: Sink, progress: Progress | None = None) -> dict:
    headers, rows = read_csv_rows(path)
    result = sink.put_csv(recording_id, headers, rows)
    if progress:
        progress.update(1.0, len(rows))
    return {"messages": len(rows), "bytes": result.get("bytes", 0), "topics": [], "opaque_topics": []}
