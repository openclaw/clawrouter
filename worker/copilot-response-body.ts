import type { HttpOperation } from "./http-operation.ts";
import { consumeCopilotResponse } from "./copilot-response-stream.ts";

// Transport only. The caller owns capacity, destination/credential authority,
// decoding and fresh authorization through final publication of the result.
export async function readCopilotResponseText(response: Response, input: Readonly<{
  operation: HttpOperation;
  expectedUrl: string;
  profile: "catalog" | "device";
}>): Promise<string> {
  return consumeCopilotResponse(response, input, () => {
    const maximum = input.profile === "catalog" ? 2 * 1024 * 1024 : input.profile === "device" ? 8192 : 0;
    if (!maximum) throw new Error("invalid_copilot_response_body");
    const bytes = new Uint8Array(maximum);
    let size = 0;
    return {
      push(part) { bytes.set(part, size); size += part.byteLength; },
      finish() { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); },
    };
  });
}
