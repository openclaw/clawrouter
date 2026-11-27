import "./typescript-setup.mjs";
import { ResponsesWebSocketSession } from "../responses-websocket-session.ts";

class Socket extends EventTarget {
  sent = [];
  closed = false;
  send(value) { if (this.closed) throw new Error("closed"); this.sent.push(value); }
  receive(value) { const event = new Event("message"); event.data = typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value; this.dispatchEvent(event); }
  close(code) { if (this.closed) return; this.closed = true; this.closeCode = code; this.dispatchEvent(new Event("close")); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const client = new Socket(), upstream = new Socket(), admitted = [], settled = [], pending = [];
  const session = new ResponsesWebSocketSession(client, {
    limits: options.limits,
    observeControl: options.observeControl,
    waitUntil(promise) { pending.push(promise); },
    async admit(body, lane, requestId, pin, signal) {
      const index = admitted.length;
      admitted.push({ body, lane, requestId, pin, signal });
      if (options.admit) await options.admit(index, body, signal);
      return { pin: "fixture-route:grant-1", payload: JSON.stringify({ type: "response.create", ...body, ...(lane ? { stream_id: lane } : {}) }), timeoutMs: 600_000, connect: options.connect ?? (async () => upstream), beforeSend: () => options.beforeSend?.(index), publish: async (identities, frame) => { await options.publish?.(index, identities, frame); }, settle: async (outcome, terminal, sent, executionStarted) => { settled.push({ index, outcome, terminal, sent, executionStarted }); await options.settle?.(index); } };
    },
  });
  t.after(async () => { session.close(); await Promise.all(pending); });
  return { client, upstream, admitted, settled, session, pending };
}
const create = (lane, extra = {}) => ({ type: "response.create", model: "fixture-model", input: "hello", ...(lane === undefined ? {} : { stream_id: lane }), ...extra });
const complete = (lane, id = "response-1", extra = {}) => ({ type: "response.completed", ...(lane === undefined ? {} : { stream_id: lane }), response: { id, service_tier: "priority", usage: { input_tokens: 1, output_tokens: 2 }, ...extra } });
function respond(f, lane, id = "response-1") {
  f.upstream.receive({ type: "response.created", ...(lane === undefined ? {} : { stream_id: lane }), response: { id } });
  f.upstream.receive(complete(lane, id));
}

export { Socket, tick, fixture, create, complete, respond };
