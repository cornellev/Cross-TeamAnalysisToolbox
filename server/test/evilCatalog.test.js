// Run with: npm test   (node:test; no database needed)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createEvilCatalog, ensureReady, TOUCH_EVERY_MS, READY_TTL_MS } = require("../evilCatalog");

function fakeEvil() {
  const calls = [];
  const state = { cache: {}, recs: [], touches: 0, down: false };
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.down) return send(500, { detail: "boom" });
    const m = req.url.match(/^\/recordings\/([^/]+)\/cache(\/touch)?$/);
    if (req.url.startsWith("/cat/recordings")) {
      const kind = new URL(req.url, "http://x").searchParams.get("kind");
      return send(200, state.recs.filter((r) => r.kind === kind));
    }
    if (m && m[2]) {
      state.touches++;
      return send(200, { touched: true });
    }
    if (m && req.method === "POST") {
      if (m[1] === "mp4") return send(409, { detail: "this recording cannot be opened in CAT" });
      if (m[1] === "missing") return send(404, { detail: "recording not found" });
      state.cache[m[1]] = { recording_id: m[1], state: "queued", progress: null, error: null };
      return send(202, state.cache[m[1]]);
    }
    if (m) {
      if (m[1] === "missing") return send(404, { detail: "recording not found" });
      return send(200, state.cache[m[1]] || { recording_id: m[1], state: "absent", progress: null, error: null });
    }
    send(404, { detail: "no route" });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, calls, state, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

async function appWith(evil) {
  const app = express();
  app.get("/api/rosbags/:folderName", ensureReady(evil, "folderName"), (req, res) => res.json({ data: "rows" }));
  app.get("/api/csv/:name", ensureReady(evil, "name"), (req, res) => res.json({ data: "csv" }));
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("disabled (no EVIL_UPLOAD_URL): reads pass straight through and nothing calls EVIL", async () => {
  const evil = createEvilCatalog({ baseUrl: "" });
  assert.equal(evil.enabled, false);
  const { server, url } = await appWith(evil);
  const res = await fetch(`${url}/api/rosbags/anything`);
  assert.equal(res.status, 200);
  server.close();
});

test("lists keep the old field names but carry the recording id and a human label", async () => {
  const f = await fakeEvil();
  f.state.recs = [
    { kind: "bag", recording_id: "r1", name: "Costmap run", cache_state: "ready", cache_progress: null, cache_error: null, category: "testing" },
    { kind: "csv", recording_id: "c1", name: "0409.csv", cache_state: "absent", uploaded_at: 5 },
  ];
  const evil = createEvilCatalog({ baseUrl: f.url });
  const bags = await evil.listBags();
  assert.deepEqual([bags[0].folder_name, bags[0].label, bags[0].cache_state], ["r1", "Costmap run", "ready"]);
  const csvs = await evil.listCsvs();
  assert.deepEqual([csvs[0].name, csvs[0].label, csvs[0].cache_state], ["c1", "0409.csv", "absent"]);
  f.server.close();
});

test("reads of a recording that is not ready answer 409 with its state; ready ones pass", async () => {
  const f = await fakeEvil();
  const evil = createEvilCatalog({ baseUrl: f.url });
  const { server, url } = await appWith(evil);

  let res = await fetch(`${url}/api/rosbags/r1`);
  assert.equal(res.status, 409);
  let body = await res.json();
  assert.equal(body.state, "absent");
  assert.match(body.message, /being prepared/);

  f.state.cache.r1 = { recording_id: "r1", state: "failed", progress: null, error: "no module weird" };
  res = await fetch(`${url}/api/rosbags/r1`);
  body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.message, /failed: no module weird/);

  f.state.cache.r1 = { recording_id: "r1", state: "ready" };
  res = await fetch(`${url}/api/rosbags/r1`);
  assert.equal(res.status, 200);
  res = await fetch(`${url}/api/csv/r1`);
  assert.equal(res.status, 200);

  res = await fetch(`${url}/api/rosbags/missing`);
  assert.equal(res.status, 404);
  server.close();
  f.server.close();
});

test("a ready answer is trusted for a short time, so paged reads do not each call EVIL", async () => {
  const f = await fakeEvil();
  let t = 1_000_000;
  const evil = createEvilCatalog({ baseUrl: f.url, now: () => t });
  f.state.cache.r1 = { recording_id: "r1", state: "ready" };
  const { server, url } = await appWith(evil);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(`${url}/api/rosbags/r1`)).status, 200);
  const stateCalls = () => f.calls.filter((c) => c === "GET /recordings/r1/cache").length;
  assert.equal(stateCalls(), 1);
  t += READY_TTL_MS + 1;
  await fetch(`${url}/api/rosbags/r1`);
  assert.equal(stateCalls(), 2);
  server.close();
  f.server.close();
});

test("'in use' is reported to EVIL at most once a minute per recording", async () => {
  const f = await fakeEvil();
  let t = 5_000_000;
  const evil = createEvilCatalog({ baseUrl: f.url, now: () => t });
  for (let i = 0; i < 10; i++) await evil.touch("r1");
  assert.equal(f.state.touches, 1);
  await evil.touch("r2");
  assert.equal(f.state.touches, 2);
  t += TOUCH_EVERY_MS + 1;
  await evil.touch("r1");
  assert.equal(f.state.touches, 3);
  f.server.close();
});

test("prepare queues a build and surfaces EVIL's refusals", async () => {
  const f = await fakeEvil();
  const evil = createEvilCatalog({ baseUrl: f.url });
  assert.equal((await evil.prepare("r1")).state, "queued");
  await assert.rejects(evil.prepare("mp4"), (e) => e.status === 409 && /cannot be opened in CAT/.test(e.message));
  await assert.rejects(evil.prepare("missing"), (e) => e.status === 404);
  f.server.close();
});

test("an unreachable or failing EVIL gives a clear 502, never a hang or a crash", async () => {
  const f = await fakeEvil();
  const evil = createEvilCatalog({ baseUrl: f.url });
  const { server, url } = await appWith(evil);
  f.state.down = true;
  const res = await fetch(`${url}/api/rosbags/r1`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /EVIL is unreachable/);
  // data already cached keeps being readable while EVIL is briefly down (within the trust window)
  f.state.down = false;
  f.state.cache.r2 = { recording_id: "r2", state: "ready" };
  assert.equal((await fetch(`${url}/api/rosbags/r2`)).status, 200);
  f.state.down = true;
  assert.equal((await fetch(`${url}/api/rosbags/r2`)).status, 200);
  server.close();
  f.server.close();
  const dead = createEvilCatalog({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(dead.listBags(), (e) => e.status === 502);
});
