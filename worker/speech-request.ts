import type { CompiledModel } from "./types.ts";
import { HttpError } from "./utils.ts";

export function validateSpeechRequest(body: Record<string, unknown>, model: CompiledModel | null): void {
  if (!model) throw new HttpError(400, "model_required", "a registered speech model is required");
  // The legacy speech API accepts at most 4096 characters and binary audio;
  // SSE belongs to newer speech models, outside this endpoint's qualified contract.
  if (typeof body.input !== "string" || !body.input.length || [...body.input].length > 4096) throw new HttpError(400, "invalid_speech_input", "speech input must contain 1 to 4096 Unicode code points");
  if (Object.hasOwn(body, "instructions")) throw new HttpError(400, "unsupported_speech_instructions", "this speech model does not support instructions");
  if (body.stream_format !== undefined && body.stream_format !== "audio") throw new HttpError(400, "unsupported_speech_stream", "this speech model supports binary audio only");
}
