import { renderHook, act, render, screen, waitFor } from "@testing-library/react";
import { useRecordingPrep, isReady, PrepareBanner, UploadNotice } from "./cachePrep";

const reply = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("with EVIL off everything is ready immediately and EVIL is never called", async () => {
  global.fetch = jest.fn();
  const { result } = renderHook(() => useRecordingPrep(false));
  await act(async () => {
    await result.current.prepare("bag-1");
  });
  expect(result.current.prep).toMatchObject({ id: "bag-1", status: "ready" });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(isReady(result.current.prep, "bag-1", false)).toBe(true);
  expect(isReady({ id: null, status: "idle" }, "x", false)).toBe(true); // legacy mode never blocks
});

test("an already-built cache is ready after one call", async () => {
  global.fetch = jest.fn(() => reply({ state: "ready" }, true, 202));
  const { result } = renderHook(() => useRecordingPrep(true));
  await act(async () => {
    await result.current.prepare("r1");
  });
  expect(result.current.prep.status).toBe("ready");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/recordings\/r1\/prepare$/);
  expect(global.fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
  expect(isReady(result.current.prep, "r1", true)).toBe(true);
  expect(isReady(result.current.prep, "other", true)).toBe(false);
});

test("queued then building then ready: shows progress, polls, and finishes", async () => {
  jest.useFakeTimers();
  const states = [{ state: "queued" }, { state: "building", progress: 0.4 }, { state: "ready" }];
  global.fetch = jest.fn(() => reply(states.shift()));
  const { result } = renderHook(() => useRecordingPrep(true));

  let done;
  act(() => {
    done = result.current.prepare("r2");
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.prep).toMatchObject({ status: "preparing", message: "Queued…" });

  await act(async () => {
    jest.advanceTimersByTime(1600);
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.prep).toMatchObject({ status: "preparing", progress: 0.4 }));

  await act(async () => {
    jest.advanceTimersByTime(1600);
    await Promise.resolve();
  });
  await act(async () => {
    await done;
  });
  expect(result.current.prep.status).toBe("ready");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/api\/recordings\/r2\/cache$/);
});

test("a failed build is reported with its reason, and so is an EVIL error", async () => {
  global.fetch = jest.fn(() => reply({ state: "failed", error: "no module weird" }));
  const { result } = renderHook(() => useRecordingPrep(true));
  await act(async () => {
    await result.current.prepare("r3");
  });
  expect(result.current.prep).toMatchObject({ status: "failed", message: "no module weird" });

  global.fetch = jest.fn(() => reply({ error: "this recording cannot be opened in CAT" }, false, 409));
  await act(async () => {
    await result.current.prepare("mp4");
  });
  expect(result.current.prep).toMatchObject({ status: "failed", message: "this recording cannot be opened in CAT" });
});

test("choosing another recording abandons the old poll", async () => {
  jest.useFakeTimers();
  global.fetch = jest.fn((url) =>
    reply(url.includes("/old/") ? { state: "building", progress: 0.1 } : { state: "ready" })
  );
  const { result } = renderHook(() => useRecordingPrep(true));
  act(() => {
    result.current.prepare("old");
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await result.current.prepare("new");
  });
  expect(result.current.prep).toMatchObject({ id: "new", status: "ready" });
  const callsBefore = global.fetch.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
  });
  expect(global.fetch.mock.calls.length).toBe(callsBefore); // the stale poll for "old" stopped
});

test("the banner says what is happening, nothing when ready or idle", () => {
  const { rerender, container } = render(<PrepareBanner prep={{ status: "preparing", progress: 0.5, message: "Preparing…" }} />);
  expect(screen.getByRole("status").textContent).toMatch(/Preparing… 50%/);
  rerender(<PrepareBanner prep={{ status: "failed", message: "boom" }} />);
  expect(screen.getByRole("status").textContent).toMatch(/Could not prepare this recording: boom/);
  rerender(<PrepareBanner prep={{ status: "ready" }} />);
  expect(container.textContent).toBe("");
  rerender(<UploadNotice url="http://cev-evil/" />);
  expect(screen.getByRole("link").getAttribute("href")).toBe("http://cev-evil/");
});
