// Synthetic Node cert responses have an explicit byte producer. This is not
// evidence about workerd's HTTP transport; the isolated fixture covers that.
export function accessBytesResponse(value, url, init = {}) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let offset = 0;
  const response = new Response(new ReadableStream({ type: "bytes", pull(controller) {
    const request = controller.byobRequest;
    if (offset === bytes.length) { controller.close(); request?.respond(0); return; }
    const count = Math.min(request.view.byteLength, bytes.length - offset, 16384);
    request.view.set(bytes.subarray(offset, offset + count)); offset += count; request.respond(count);
  } }), { headers: { "content-type": "application/json" }, ...init });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
export const accessCertsResponse = (value, url) => accessBytesResponse(JSON.stringify(value), url);
