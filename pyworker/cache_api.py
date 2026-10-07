"""HTTP API for CAT's cache (EVIL: recording-catalog-design.md, Phase 4).

EVIL decides WHEN (lazy build on first open, eviction after a week idle); these endpoints do the work.
Files are read from EVIL's raw store, mounted read-only; EVIL sends paths relative to it.
Kept separate from main.py so it can be run and tested without the Shiny app.
"""

from __future__ import annotations

import json
import os
import subprocess

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import cache_core
from cache_job import extra_environment

router = APIRouter()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_ROOT = os.getenv("EVIL_RAW_ROOT", "/evil-data/raw")
BUILD_TIMEOUT_SEC = float(os.getenv("CACHE_BUILD_TIMEOUT_SEC", str(2 * 3600)))
JOB = os.path.join(BASE_DIR, "cache_job.py")


class BuildRequest(BaseModel):
    recording_id: str
    kind: str                      # "bag" | "csv"
    files: list[str]
    name: str | None = None


def _run_job(args: list[str], timeout: float) -> dict:
    """A fresh interpreter per job: extra message packages are picked up without a rebuild, and a
    bag that crashes the ROS bindings kills only that child."""
    try:
        done = subprocess.run(["python3", JOB, *args], cwd=BASE_DIR, env=extra_environment(),
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail=f"cache build exceeded {timeout:.0f}s")
    lines = [l for l in done.stdout.splitlines() if l.startswith(("RESULT ", "ERROR "))]
    if not lines:
        tail = (done.stderr or done.stdout).strip().splitlines()[-1:] or ["no output"]
        raise HTTPException(status_code=500, detail=f"cache job crashed (exit {done.returncode}): {tail[0]}")
    kind, _, payload = lines[-1].partition(" ")
    if kind == "ERROR":
        raise HTTPException(status_code=422, detail=payload)
    return json.loads(payload)


@router.post("/cache/build")
def cache_build(req: BuildRequest):
    if req.kind not in ("bag", "csv"):
        raise HTTPException(status_code=400, detail="kind must be 'bag' or 'csv'")
    try:
        cache_core.resolve_files(RAW_ROOT, req.files)          # fail fast, with a readable reason
    except cache_core.CacheError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    result = _run_job(["build", req.recording_id, req.kind, RAW_ROOT, *req.files], BUILD_TIMEOUT_SEC)
    return {"recording_id": req.recording_id, **result}


@router.get("/cache/progress/{recording_id}")
def cache_progress(recording_id: str):
    return cache_core.Progress.read(recording_id) or {"fraction": None, "messages": None}


@router.delete("/cache/{recording_id}")
def cache_delete(recording_id: str, kind: str = "bag"):
    if kind not in ("bag", "csv"):
        raise HTTPException(status_code=400, detail="kind must be 'bag' or 'csv'")
    return {"recording_id": recording_id, **_run_job(["delete", recording_id, kind], 300)}
