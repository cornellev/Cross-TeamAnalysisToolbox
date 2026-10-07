"""One cache build, run in its OWN process (a fresh interpreter), so message packages mounted
into /ros_ws/extra after the image was built are picked up without a rebuild, and a bag that
crashes the ROS bindings kills only this child.

    python3 cache_job.py build  <recording_id> <kind: bag|csv> <raw_root> <rel_path>...
    python3 cache_job.py delete <recording_id> <kind>

Prints a final `RESULT <json>` line (or `ERROR <message>`). Progress goes to a file read by
GET /cache/progress/<id> (cache_core.Progress).
"""

from __future__ import annotations

import glob
import json
import os
import sys
from pathlib import Path

import cache_core as core

EXTRA_ROOT = os.getenv("EXTRA_MSG_ROOT", "/ros_ws/extra")


def extra_environment(extra_root: str = EXTRA_ROOT, env: dict | None = None) -> dict:
    """Environment that makes pre-built extra message packages importable: every colcon install
    space under <extra_root>/install/<pkg>. Add a package by running scripts/build_msg_package.sh;
    no image rebuild."""
    env = dict(os.environ if env is None else env)
    prefixes = sorted(glob.glob(os.path.join(extra_root, "install", "*")))
    if not prefixes:
        return env
    py = [p for prefix in prefixes for p in glob.glob(os.path.join(prefix, "lib", "python3*", "site-packages"))]
    lib = [os.path.join(prefix, "lib") for prefix in prefixes]
    env["AMENT_PREFIX_PATH"] = os.pathsep.join(prefixes + ([env["AMENT_PREFIX_PATH"]] if env.get("AMENT_PREFIX_PATH") else []))
    env["PYTHONPATH"] = os.pathsep.join(py + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    env["LD_LIBRARY_PATH"] = os.pathsep.join(lib + ([env["LD_LIBRARY_PATH"]] if env.get("LD_LIBRARY_PATH") else []))
    return env


class RosbagReader:
    """core.BagReader over rosbag2_py. Imported lazily: this module's helpers work without ROS."""

    def __init__(self, uri: str):
        import rosbag2_py

        self._uri = uri
        self._rosbag2_py = rosbag2_py
        reader = rosbag2_py.SequentialReader()
        reader.open(rosbag2_py.StorageOptions(uri=uri, storage_id="sqlite3"),
                    rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr"))
        self._reader = reader
        self._types = {m.name: m.type for m in reader.get_all_topics_and_types()}
        self._counts: int | None = None
        try:
            md = rosbag2_py.Info().read_metadata(uri, "sqlite3")
            self._counts = int(md.message_count)
        except Exception:
            pass

    def topics(self) -> dict[str, str]:
        return dict(self._types)

    def total_messages(self) -> int | None:
        return self._counts

    def messages(self):
        while self._reader.has_next():
            topic, data, t = self._reader.read_next()
            yield topic, t, bytes(data)

    def decoder(self, topic_type: str):
        try:
            from rclpy.serialization import deserialize_message
            from rosidl_runtime_py.utilities import get_message

            msg_cls = get_message(topic_type)
        except Exception:                      # package not installed in this image: stored opaque
            return None
        return lambda data: deserialize_message(data, msg_cls)


def main(argv: list[str]) -> int:
    from cache_sink import PostgresSink

    if len(argv) >= 3 and argv[0] == "delete":
        n = PostgresSink().delete(argv[1], argv[2])
        print("RESULT " + json.dumps({"deleted": n}))
        return 0
    if len(argv) < 5 or argv[0] != "build":
        print("ERROR usage: cache_job.py build <recording_id> <bag|csv> <raw_root> <rel_path>...")
        return 2
    recording_id, kind, raw_root, rels = argv[1], argv[2], argv[3], argv[4:]
    progress = core.Progress(recording_id)
    try:
        paths = core.resolve_files(raw_root, rels)
        sink = PostgresSink()
        if kind == "csv":
            csv_file = next((p for p in paths if p.suffix.lower() == ".csv"), None)
            if csv_file is None:
                raise core.CacheError("no .csv file in this recording")
            result = core.build_csv(recording_id, csv_file, sink, progress)
        elif kind == "bag":
            yaml_file = next((p for p in paths if p.name == "metadata.yaml"), None)
            reader = RosbagReader(core.bag_uri(paths))
            result = core.build_bag(recording_id, reader, sink, progress=progress,
                                    yaml_text=yaml_file.read_text() if yaml_file else None)
        else:
            raise core.CacheError(f"unknown kind {kind!r}")
    except core.CacheError as exc:
        print(f"ERROR {exc}")
        return 1
    except Exception as exc:
        print(f"ERROR {type(exc).__name__}: {exc}")
        return 1
    finally:
        progress.clear()
    print("RESULT " + json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
