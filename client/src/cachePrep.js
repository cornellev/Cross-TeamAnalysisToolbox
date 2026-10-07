// CAT as a cache of EVIL's recordings: the first time someone opens a recording, EVIL builds its
// cache (CAT's pyworker decodes it). These helpers drive the "preparing..." state in the tabs.
import React, { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = (process.env.REACT_APP_API_URL || "").replace(/\/$/, "");
const POLL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(response) {
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    /* no body */
  }
  if (!response.ok) {
    throw new Error(body?.error || body?.message || `request failed (${response.status})`);
  }
  return body;
}

export function useCatConfig() {
  const [config, setConfig] = useState({ evil: false, legacy_upload: true, evil_ui_url: null });
  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => c && setConfig(c))
      .catch(() => {});
  }, []);
  return config;
}

/**
 * prep = { id, status: "idle" | "preparing" | "ready" | "failed", progress, message }.
 * prepare(id) asks EVIL for the cache and polls until it is ready or failed. With EVIL integration
 * off (`enabled` false) everything is immediately ready, as it always was.
 */
export function useRecordingPrep(enabled) {
  const [prep, setPrep] = useState({ id: null, status: "idle", progress: null, message: "" });
  const token = useRef(0);

  useEffect(() => () => void (token.current += 1), []);

  const reset = useCallback(() => {
    token.current += 1;
    setPrep({ id: null, status: "idle", progress: null, message: "" });
  }, []);

  const prepare = useCallback(
    async (id) => {
      const mine = ++token.current;
      if (!id) return setPrep({ id: null, status: "idle", progress: null, message: "" });
      if (!enabled) return setPrep({ id, status: "ready", progress: null, message: "" });
      setPrep({ id, status: "preparing", progress: null, message: "Asking EVIL to prepare this recording…" });
      try {
        let state = await json(
          await fetch(`${API_BASE}/api/recordings/${encodeURIComponent(id)}/prepare`, { method: "POST" })
        );
        while (mine === token.current) {
          if (state.state === "ready") return setPrep({ id, status: "ready", progress: null, message: "" });
          if (state.state === "failed") {
            return setPrep({ id, status: "failed", progress: null, message: state.error || "unknown error" });
          }
          setPrep({
            id,
            status: "preparing",
            progress: state.progress,
            message: state.state === "queued" ? "Queued…" : "Preparing…",
          });
          await sleep(POLL_MS);
          if (mine !== token.current) return;
          state = await json(await fetch(`${API_BASE}/api/recordings/${encodeURIComponent(id)}/cache`));
        }
      } catch (err) {
        if (mine === token.current) setPrep({ id, status: "failed", progress: null, message: err.message });
      }
    },
    [enabled]
  );

  return { prep, prepare, reset };
}

export const isReady = (prep, id, enabled) => !enabled || (prep.id === id && prep.status === "ready");

export function PrepareBanner({ prep }) {
  if (prep.status === "idle" || prep.status === "ready") return null;
  const failed = prep.status === "failed";
  const pct = prep.progress != null ? ` ${Math.round(prep.progress * 100)}%` : "";
  return (
    <div
      role="status"
      style={{
        margin: "8px 0",
        padding: "6px 10px",
        borderRadius: 4,
        fontSize: "0.85rem",
        background: failed ? "#4a1f1f" : "#1f3a4a",
        color: failed ? "#ff9a9a" : "#a8d8ff",
      }}
    >
      {failed ? `Could not prepare this recording: ${prep.message}` : `${prep.message}${pct}`}
      {!failed && " The first open of a recording takes a while; later opens are instant."}
    </div>
  );
}

export function UploadNotice({ url }) {
  return (
    <div style={{ margin: "8px 0", fontSize: "0.85rem", color: "#bbb" }}>
      Upload recordings in{" "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "#8ab4f8" }}>
          EVIL
        </a>
      ) : (
        "EVIL"
      )}
      ; they show up here automatically.
    </div>
  );
}
