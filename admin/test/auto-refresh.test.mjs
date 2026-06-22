import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_REFRESH_INTERVAL_MS, installAutoRefresh } from "../src/auto-refresh.ts";

test("auto refresh runs on its interval and when a visible tab regains focus", () => {
  const windowTarget = new FakeWindow();
  const documentTarget = new FakeDocument();
  let refreshes = 0;
  const uninstall = installAutoRefresh(() => { refreshes += 1; }, windowTarget, documentTarget);

  assert.equal(windowTarget.intervalMs, AUTO_REFRESH_INTERVAL_MS);
  windowTarget.intervalHandler();
  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(refreshes, 3);

  documentTarget.visibilityState = "hidden";
  windowTarget.intervalHandler();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(refreshes, 3);

  uninstall();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(refreshes, 3);
  assert.equal(windowTarget.clearedInterval, 1);
});

class FakeWindow extends EventTarget {
  intervalHandler = () => {};
  intervalMs = 0;
  clearedInterval = 0;

  setInterval(handler, milliseconds) {
    this.intervalHandler = handler;
    this.intervalMs = milliseconds;
    return 1;
  }

  clearInterval(interval) {
    this.clearedInterval = interval;
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
}
