// CAT as a derived cache of EVIL's recordings (EVIL: recording-catalog-design.md, Phase 4).
//
// When EVIL_UPLOAD_URL is set, EVIL's recording catalog is the source of truth: CAT lists recordings
// from it, asks it to build a recording's cache the first time someone opens it (EVIL queues the job,
// CAT's pyworker does the work), and tells it when a cache is being used so it is not evicted.
// Without EVIL_UPLOAD_URL CAT behaves exactly as before (own uploads, own list).
//
// Cache key = EVIL's recording_id. The existing API shapes are kept: `folder_name` (bags) and
// `name` (CSVs) now hold the recording id, with the human name in `label`.

const axios = require("axios");

const TOUCH_EVERY_MS = 60 * 1000; // tell EVIL "in use" at most once a minute per recording
const READY_TTL_MS = 30 * 1000; // trust a "ready" answer this long, so paged reads do not each call EVIL

function createEvilCatalog({
  baseUrl = process.env.EVIL_UPLOAD_URL,
  http = axios,
  now = () => Date.now(),
} = {}) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  const enabled = Boolean(base);
  const lastTouch = new Map();
  const readyUntil = new Map();

  async function call(method, path) {
    try {
      const res = await http.request({ method, url: base + path, timeout: 10000 });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;
      const e = new Error(detail || err.message || "EVIL request failed");
      e.status = status || 502;
      e.upstream = Boolean(err.response);
      throw e;
    }
  }

  const toBag = (r) => ({
    folder_name: r.recording_id,
    label: r.name,
    recorded_start: r.recorded_start,
    category: r.category,
    car: r.car,
    total_bytes: r.total_bytes,
    cache_state: r.cache_state,
    cache_progress: r.cache_progress,
    cache_error: r.cache_error,
  });

  const toCsv = (r) => ({
    name: r.recording_id,
    label: r.name,
    uploaded_at: r.uploaded_at,
    category: r.category,
    cache_state: r.cache_state,
    cache_progress: r.cache_progress,
    cache_error: r.cache_error,
  });

  return {
    enabled,
    async listBags() {
      return (await call("GET", "/cat/recordings?kind=bag")).map(toBag);
    },
    async listCsvs() {
      return (await call("GET", "/cat/recordings?kind=csv")).map(toCsv);
    },
    cacheState(id) {
      return call("GET", `/recordings/${encodeURIComponent(id)}/cache`);
    },
    prepare(id) {
      readyUntil.delete(id);
      return call("POST", `/recordings/${encodeURIComponent(id)}/cache`);
    },
    async touch(id) {
      const t = now();
      if (t - (lastTouch.get(id) || 0) < TOUCH_EVERY_MS) return;
      lastTouch.set(id, t);
      try {
        await call("POST", `/recordings/${encodeURIComponent(id)}/cache/touch`);
      } catch (_) {
        // an unreachable EVIL must not break reads of data that is already cached
      }
    },
    /** Resolves to null if the cache is ready (and marks it used), else the state object to report. */
    async blocker(id) {
      if ((readyUntil.get(id) || 0) > now()) {
        this.touch(id);
        return null;
      }
      const state = await this.cacheState(id);
      if (state.state === "ready") {
        readyUntil.set(id, now() + READY_TTL_MS);
        this.touch(id);
        return null;
      }
      return state;
    },
    forget(id) {
      readyUntil.delete(id);
    },
  };
}

/** Express middleware for routes under /api/rosbags/:folderName and /api/csv/:name. */
function ensureReady(evil, param) {
  return async (req, res, next) => {
    if (!evil.enabled) return next();
    const id = req.params[param];
    try {
      const blocked = await evil.blocker(id);
      if (!blocked) return next();
      return res.status(409).json({
        error: "recording is not ready",
        state: blocked.state,
        progress: blocked.progress,
        detail: blocked.error,
        message:
          blocked.state === "failed"
            ? `Preparing this recording failed: ${blocked.error || "unknown error"}`
            : "This recording is being prepared for CAT. Try again in a moment.",
      });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: "recording not found" });
      return res.status(502).json({ error: `EVIL is unreachable: ${err.message}` });
    }
  };
}

module.exports = { createEvilCatalog, ensureReady, TOUCH_EVERY_MS, READY_TTL_MS };
