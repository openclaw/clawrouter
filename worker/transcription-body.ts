import { HttpOperation } from "./http-operation.ts";
import { HttpError } from "./utils.ts";

// Router envelope, deliberately <= the vendor's 25 MB file limit. These are
// transport/memory limits, NOT audio duration or billable-token bounds.
export const transcriptionLimits = { file: 25_000_000, raw: 25_032_768, response: 2_097_152, prompt: 16_384, headers: 2048, parts: 6, readMs: 30_000 } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const formats: Record<string, string[]> = {
  flac: ["audio/flac", "audio/x-flac"], ogg: ["audio/ogg", "application/ogg"],
  mp3: ["audio/mpeg", "audio/mp3"], mpeg: ["audio/mpeg"], mpga: ["audio/mpeg"],
  mp4: ["audio/mp4", "video/mp4"], m4a: ["audio/mp4", "audio/x-m4a"],
  wav: ["audio/wav", "audio/wave", "audio/x-wav"], webm: ["audio/webm", "video/webm"],
};

export interface TranscriptionUpload { file: File; fields: Record<string, string> }

// No clone/tee and no unbounded request.formData(). Bound the raw reader first;
// parse strict common multipart framing directly so path-bearing filenames are
// rejected before a runtime form parser could normalize them to a basename.
export async function readTranscriptionUpload(request: Request): Promise<TranscriptionUpload> {
  if (request.headers.has("content-encoding")) invalid("content encoding is unsupported");
  const type = request.headers.get("content-type") ?? "";
  const match = /^multipart\/form-data;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=? -]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))$/i.exec(type);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.endsWith(" ")) invalid("multipart/form-data with one safe boundary is required");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) invalid("invalid content length");
  if (length !== null && Number(length) > transcriptionLimits.raw) tooLarge();
  const operation = new HttpOperation(request.signal, transcriptionLimits.readMs);
  try {
    const raw = await readBounded(request.body, transcriptionLimits.raw, operation, 413);
    return parseMultipart(raw, boundary);
  } catch (error) {
    if (operation.status === "timeout") throw new HttpError(408, "transcription_read_timeout", "multipart upload deadline exceeded");
    if (operation.status === "client_error") throw new HttpError(400, "transcription_canceled", "multipart upload was canceled");
    throw error;
  } finally { operation.stop("complete"); }
}

export async function readBounded(body: ReadableStream<Uint8Array> | null, maximum: number, operation: HttpOperation, status = 502): Promise<Uint8Array<ArrayBuffer>> {
  operation.signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  // A bounded number of chunks even for an adversarial one-byte stream.
  let buffer = new Uint8Array(Math.min(maximum, 8192)), used = 0, complete = false;
  try {
    while (true) {
      const next = await operation.wait(reader.read());
      if (next.done) { complete = true; return buffer.slice(0, used); }
      if (next.value.byteLength > maximum - used) throw new HttpError(status, "transcription_body_too_large", "transcription body exceeds router byte limit");
      const required = used + next.value.byteLength;
      if (required > buffer.length) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(required, buffer.length * 2)));
        grown.set(buffer.subarray(0, used)); buffer = grown;
      }
      buffer.set(next.value, used); used = required;
    }
  } finally {
    if (!complete) void reader.cancel(operation.signal.reason).catch(() => undefined);
    // Pending reads may finish after abort; cancellation owns their disposal.
    reader.releaseLock();
  }
}

function parseMultipart(raw: Uint8Array<ArrayBuffer>, boundary: string): TranscriptionUpload {
  const marker = encoder.encode('--' + boundary), separator = encoder.encode('\r\n--' + boundary), headersEnd = encoder.encode('\r\n\r\n');
  const fields: Record<string, string> = Object.create(null);
  let file: File | undefined, cursor = 0, count = 0;
  if (!at(raw, marker, 0)) invalid("multipart preamble is unsupported");
  cursor += marker.length;
  while (true) {
    if (at(raw, encoder.encode('--'), cursor)) {
      cursor += 2;
      if (at(raw, encoder.encode('\r\n'), cursor)) cursor += 2;
      if (cursor !== raw.length) invalid("multipart epilogue is unsupported");
      break;
    }
    if (!at(raw, encoder.encode('\r\n'), cursor) || ++count > transcriptionLimits.parts) invalid("invalid multipart framing or part count");
    cursor += 2;
    const end = find(raw, headersEnd, cursor, Math.min(raw.length, cursor + transcriptionLimits.headers + 4));
    if (end < 0 || end - cursor > transcriptionLimits.headers) invalid("multipart part headers exceed limit");
    const text = ascii(raw.subarray(cursor, end));
    const headers = new Map<string, string>();
    for (const line of text.split('\r\n')) {
      const header = /^(Content-Disposition|Content-Type):[ \t]*([^\r\n]+)$/i.exec(line);
      if (!header || headers.has(header[1].toLowerCase())) invalid("unsupported or duplicate part header");
      headers.set(header[1].toLowerCase(), header[2]);
    }
    const disposition = /^form-data; name="([a-z_]+)"(?:; filename="([^"\r\n]*)")?$/.exec(headers.get("content-disposition") ?? "");
    if (!disposition) invalid("invalid multipart disposition");
    const name = disposition[1], filename = disposition[2];
    cursor = end + 4;
    const next = findBoundary(raw, separator, cursor);
    if (next < 0) invalid("multipart closing boundary is missing");
    const bytes = raw.subarray(cursor, next);
    if (name === "file") {
      if (file || filename === undefined) invalid("exactly one File is required");
      if (!bytes.length || bytes.length > transcriptionLimits.file) tooLarge();
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(filename) || filename.includes('..')) invalid("unsafe audio filename");
      const extension = filename.split('.').at(-1)?.toLowerCase() ?? "";
      const mime = headers.get("content-type")?.toLowerCase() ?? "";
      // Official Node SDK streams default to octet-stream; the supported safe
      // filename still identifies the format, and original MIME remains intact.
      if (!formats[extension] || mime !== "application/octet-stream" && !formats[extension].includes(mime)) invalid("unsupported audio filename/MIME pair");
      file = new File([bytes], filename, { type: mime });
    } else {
      if (filename !== undefined || headers.has("content-type") || Object.hasOwn(fields, name)) invalid("duplicate or wrong-type multipart field");
      const maximum = name === "prompt" ? transcriptionLimits.prompt : name === "model" ? 128 : name === "language" ? 2 : name === "response_format" ? 4 : name === "stream" ? 5 : 0;
      if (!maximum) throw new HttpError(400, "transcription_option_unsupported", "unsupported transcription option");
      if (bytes.length > maximum) invalid("multipart field exceeds its byte limit");
      try { fields[name] = decoder.decode(bytes); } catch { invalid("multipart field must be UTF-8"); }
    }
    cursor = next + separator.length;
  }
  if (!file || !fields.model) invalid("exactly one nonempty file and model are required");
  if (fields.language !== undefined && !/^[a-z]{2}$/.test(fields.language)) invalid("language must be an ISO-639-1 code");
  if (fields.response_format !== undefined && fields.response_format !== "json" || fields.stream !== undefined && fields.stream !== "false") throw new HttpError(400, "transcription_option_unsupported", "only JSON nonstream transcription is supported");
  return { file, fields };
}
function at(bytes: Uint8Array, target: Uint8Array, offset: number): boolean { return offset + target.length <= bytes.length && target.every((byte, index) => bytes[offset + index] === byte); }
function find(bytes: Uint8Array, target: Uint8Array, start: number, end: number): number {
  for (let i = start; i + target.length <= end; i++) if (bytes[i] === target[0] && at(bytes, target, i)) return i;
  return -1;
}
// A boundary-looking audio prefix is ordinary payload unless its suffix is a
// framing delimiter. Do not truncate or reject binary data containing prefixes.
function findBoundary(bytes: Uint8Array, separator: Uint8Array, start: number): number {
  const crlf = encoder.encode('\r\n'), close = encoder.encode('--');
  for (let next = find(bytes, separator, start, bytes.length); next >= 0; next = find(bytes, separator, next + 1, bytes.length)) {
    const suffix = next + separator.length;
    if (at(bytes, crlf, suffix) || at(bytes, close, suffix)) return next;
  }
  return -1;
}
function ascii(bytes: Uint8Array): string { if (bytes.some(byte => byte < 32 && byte !== 13 && byte !== 10 && byte !== 9 || byte > 126)) invalid("part headers must be ASCII"); return decoder.decode(bytes); }
function invalid(message: string): never { throw new HttpError(400, "invalid_transcription_upload", message); }
function tooLarge(): never { throw new HttpError(413, "transcription_body_too_large", "audio file must contain 1 to 25000000 bytes and fit the raw upload limit"); }
