import { inputRetirement } from "./input-retirement.ts";
import type { NativeResponse } from "./native-response.ts";

export const nativeMp3ResponseLimit = 16 * 1024 * 1024;
type Mp3ResponseErrors = { readonly invalid: string; readonly limit: string; readonly incomplete: string };

export async function readNativeMp3Response(response: Response, signal: AbortSignal, errors: Mp3ResponseErrors): ReturnType<NativeResponse["read"]> {
  const bytes = await readAudio(response, signal, errors);
  const audio = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return { response: new Response(audio, { status: 200, headers: {
    "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), "cache-control": "no-store", "x-content-type-options": "nosniff",
  } }), usage: { tokens: null, outcome: "success" } };
}

async function readAudio(response: Response, signal: AbortSignal, errors: Mp3ResponseErrors): Promise<Uint8Array> {
  const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (!response.body) throw new Error(errors.invalid);
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")
    || response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > nativeMp3ResponseLimit)) {
    await input.retire("cancel");
    throw new Error(errors.invalid);
  }
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, eof = false;
  try {
    signal.throwIfAborted();
    const bytes = new Uint8Array(declared === null ? nativeMp3ResponseLimit : Number(declared));
    for (;;) {
      const chunk = await input.read(() => reader.read()); signal.throwIfAborted();
      if (chunk.done) { eof = true; break; }
      if (size + chunk.value.byteLength > bytes.byteLength) throw new Error(errors.limit);
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (!size || declared !== null && Number(declared) !== size) throw new Error(errors.incomplete);
    return bytes.subarray(0, size);
  } catch {
    await input.retire("cancel", signal.reason);
    throw new Error(errors.invalid);
  } finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}
