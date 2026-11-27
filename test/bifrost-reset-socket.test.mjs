import assert from "node:assert/strict";
import test from "node:test";
import { createBifrostSocketReset } from "./helpers/bifrost-reset-socket.mjs";

const url = "http://127.0.0.1:8080/chat?fixture=one";
function harness() {
  const callbacks = new Set(); let resets = 0;
  const socket = { destroyed: false, resetAndDestroy() { resets++; this.destroyed = true; } };
  const request = { method: "POST", origin: "http://127.0.0.1:8080", path: "/chat?fixture=one" };
  const owner = createBifrostSocketReset(url, name => {
    assert.equal(name, "undici:client:sendHeaders");
    return { subscribe: fn => callbacks.add(fn), unsubscribe: fn => callbacks.delete(fn) };
  });
  return { owner, socket, request, callbacks, resets: () => resets,
    send: (r = request, s = socket) => { for (const fn of callbacks) fn({ request: r, socket: s }); } };
}

test("reset targets one exact POST transport and removes its observer", () => {
  const h = harness();
  for (const difference of [{ method: "GET" }, { origin: "http://127.0.0.1:8081" }, { path: "/chat?fixture=two" }])
    h.send({ ...h.request, ...difference });
  assert.throws(() => h.owner.reset(), /not uniquely live/);
  h.send(); h.send();
  h.owner.reset(); assert.equal(h.resets(), 1);
  assert.throws(() => h.owner.reset(), /not uniquely live/);
  h.owner.close(); h.owner.close(); assert.equal(h.callbacks.size, 0);
});

test("ambiguous requests or sockets cannot acquire reset authority", () => {
  for (const change of [h => h.send({ ...h.request }), h => h.send(h.request, { ...h.socket })]) {
    const h = harness(); h.send(); change(h);
    assert.throws(() => h.owner.reset(), /not uniquely live/); assert.equal(h.resets(), 0);
    h.owner.close(); assert.equal(h.callbacks.size, 0);
  }
});

test("closed, destroyed and unsupported transports fail without a reset", () => {
  for (const change of [h => h.owner.close(), h => { h.socket.destroyed = true; }, h => { delete h.socket.resetAndDestroy; }]) {
    const h = harness(); h.send(); change(h);
    assert.throws(() => h.owner.reset(), /not uniquely live/); assert.equal(h.resets(), 0);
    h.owner.close(); assert.equal(h.callbacks.size, 0);
  }
});
