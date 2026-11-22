import { channel } from "node:diagnostics_channel";

// Scope transport control to the one fixture request, never the global pool.
export function createBifrostSocketReset(url, getChannel = channel) {
  const target = new URL(url), topic = getChannel("undici:client:sendHeaders");
  let match, ambiguous = false, closed = false, reset = false;
  const observe = ({ request, socket }) => {
    if (request?.method !== "POST" || String(request.origin) !== target.origin
      || request.path !== target.pathname + target.search) return;
    if (match && (match.request !== request || match.socket !== socket)) ambiguous = true;
    else match = { request, socket };
  };
  topic.subscribe(observe);
  return {
    reset() {
      if (closed || reset || ambiguous || !match?.socket || match.socket.destroyed
        || typeof match.socket.resetAndDestroy !== "function") throw Error("Bifrost reset transport is not uniquely live");
      reset = true;
      match.socket.resetAndDestroy();
    },
    close() {
      if (closed) return;
      closed = true;
      topic.unsubscribe(observe);
    },
  };
}
