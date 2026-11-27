// Node-only synthetic transport. Actual DO-returned BYOB is proved separately
// by minimax-search-workerd, never inferred from this fixture's known bytes.
export function byteBody(value, size = 16384) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let at = 0;
  return new ReadableStream({ type: "bytes", pull(controller) {
    if (at === bytes.length) { controller.close(); controller.byobRequest?.respond(0); return; }
    const end = Math.min(at + size, bytes.length);
    controller.enqueue(bytes.slice(at, end)); at = end;
  } }, { highWaterMark: 0 });
}
export const byteResponse = (value, init = {}) => new Response(byteBody(value), init);
export const jsonResponse = (value, init = {}) => byteResponse(JSON.stringify(value), {
  ...init, headers: { "content-type": "application/json", ...init.headers },
});
export async function syntheticTransport(response) {
  if (!response.body) return response;
  return byteResponse(new Uint8Array(await response.arrayBuffer()), response);
}
