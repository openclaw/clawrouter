import type { BackgroundJob } from "./background-store.ts";
import { HttpOperation } from "./http-operation.ts";
import { dispatchResponseControl } from "./responses-control-dispatch.ts";
import type { ResponsesObservation } from "./token-usage.ts";
import type { Env } from "./types.ts";

// Collection consumes one bounded JSON body, independently of caller delivery.
// Exhaustion/404/disconnect supplies no generation terminal and no refund.
export async function collectBackground(env: Env, job: BackgroundJob, accept: (fact: ResponsesObservation, status: number) => Promise<void>): Promise<void> {
  if (!job.responseId || !job.route || Date.now() >= job.observeUntil) return;
  const operation = new HttpOperation(undefined, Math.min(10_000, job.observeUntil - Date.now()));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let inspector: Awaited<ReturnType<typeof import("./responses-usage.ts")["createResponsesUsageInspector"]>> | undefined;
  try {
    const response = await operation.wait(dispatchResponseControl(env, { owner: job.owner, route: job.route, responseId: job.responseId, action: "retrieve", query: "", stream: job.stream, deadline: job.observeUntil }, operation.signal), "upstream", response => { void response.body?.cancel().catch(() => undefined); });
    if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => undefined); throw new Error("background observation unavailable");
    }
    const { createResponsesUsageInspector } = await import("./responses-usage.ts");
    let observed = false;
    inspector = createResponsesUsageInspector(false, undefined, async fact => {
      if (fact.id !== job.responseId) throw new Error("background identity mismatch");
      observed = true; await accept(fact, response.status);
    });
    reader = response.body.getReader();
    let size = 0;
    while (true) {
      const chunk = await operation.wait(reader.read(), "upstream");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("background observation limit");
      await operation.wait(inspector.push(chunk.value), "upstream");
    }
    await operation.wait(inspector.end(), "upstream");
    if (!observed) throw new Error("background observation unavailable");
  } finally {
    inspector?.stop();
    operation.stop("complete");
    void reader?.cancel().catch(() => undefined);
  }
}
