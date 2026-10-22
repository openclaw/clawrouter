import { createSseUsageInspector, extractUsageTokens, usageInspectionLimit, type UsageTokens } from "./token-usage.ts";
import type { HttpOperation } from "./http-operation.ts";

const error = { type: "error", error: { type: "pricing_required", code: "pricing_required", message: "Anthropic response modifiers have no qualified price. The reservation is retained; no base-rate settlement was made." } };
export interface AnthropicPriceGuard { response: Response; failure(): { tokens: UsageTokens | null } | undefined }

// Hard budgets only. JSON must be qualified before success is published. SSE
// stays demand-driven and byte-identical until a terminal price fails; then an
// error replaces that terminal frame (HTTP headers may already be delivered).
export async function guardAnthropicPrice(response: Response, priced: (tokens: UsageTokens | null) => boolean, operation: HttpOperation): Promise<AnthropicPriceGuard> {
  let failure: { tokens: UsageTokens | null } | undefined;
  if (!response.ok || !response.body) return { response, failure: () => failure };
  const reader = response.body.getReader();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const headers = new Headers(response.headers); headers.delete("content-length");
  if (!contentType.includes("text/event-stream")) {
    let size = 0; const chunks: Uint8Array[] = [];
    let tokens: UsageTokens | null = null;
    try {
      while (true) {
        const next = await operation.wait(reader.read(), "upstream");
        if (next.done) break;
        size += next.value.byteLength;
        if (size > usageInspectionLimit) { failure = { tokens }; break; }
        chunks.push(next.value);
      }
      if (!failure) {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { tokens = extractUsageTokens(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* No authoritative modifier evidence. */ }
        if (priced(tokens)) return { response: new Response(bytes, { status: response.status, headers }), failure: () => failure };
        failure = { tokens };
      }
      headers.set("content-type", "application/json");
      return { response: new Response(JSON.stringify(error), { status: 502, headers }), failure: () => failure };
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  const inspector = createSseUsageInspector(), decoder = new TextDecoder(), encoder = new TextEncoder();
  let finished = false, pending = "";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!finished) {
          let published = false;
          const next = await operation.wait(reader.read(), "upstream");
          if (finished) return;
          if (next.done) {
            pending += decoder.decode();
            if (pending) inspector.push(encoder.encode(pending));
            const observed = inspector.result();
            if (observed.outcome === "success" && !priced(observed.tokens)) {
              failure = { tokens: observed.tokens };
              controller.enqueue(encoder.encode("event: error\ndata: " + JSON.stringify(error) + "\n\n"));
            } else if (pending) controller.enqueue(encoder.encode(pending));
            finished = true; reader.releaseLock(); controller.close(); return;
          }
          pending += decoder.decode(next.value, { stream: true });
          // Don't publish a partial terminal frame before its price is known.
          // A trailing CR can still be half of a CRLF delimiter in the next read.
          let boundary: RegExpExecArray | null;
          while ((boundary = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/.exec(pending)) && !(pending.endsWith("\r") && boundary.index + boundary[0].length === pending.length)) {
            const end = boundary.index + boundary[0].length, frame = encoder.encode(pending.slice(0, end));
            pending = pending.slice(end);
            if (frame.byteLength > usageInspectionLimit) { failure = { tokens: null }; break; }
            inspector.push(frame);
            const observed = inspector.result(false);
            if (observed.outcome === "success" && !priced(observed.tokens)) { failure = { tokens: observed.tokens }; break; }
            controller.enqueue(frame); published = true;
          }
          if (pending.length > usageInspectionLimit) failure = { tokens: null };
          if (failure) {
            finished = true; pending = "";
            controller.enqueue(encoder.encode("event: error\ndata: " + JSON.stringify(error) + "\n\n"));
            controller.close(); void reader.cancel().catch(() => undefined); reader.releaseLock();
          }
          if (published || finished) return;
        }
      } catch (cause) {
        if (!finished) { finished = true; void reader.cancel(cause).catch(() => undefined); reader.releaseLock(); controller.error(cause); }
      }
    },
    cancel(reason) { if (!finished) { finished = true; void reader.cancel(reason).catch(() => undefined); reader.releaseLock(); } },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, headers }), failure: () => failure };
}
