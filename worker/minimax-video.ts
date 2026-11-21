import type { ManagedObservation, ManagedReadContext } from "./managed-lifecycle-types.ts";
import { readVideoJson, readVideoFileBytes } from "./minimax-video-operation.ts";
import type { InputRetirement } from "./input-retirement.ts";
import { mediaObject } from "./managed-media-json.ts";

export const miniMaxVideoProtocol = "minimax.video";
export const miniMaxVideoModels = ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02", "I2V-01-Director", "I2V-01-live", "I2V-01"] as const;
export const miniMaxVideoOrigins = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;
export const miniMaxCurrentCnVideoOrigin = "https://api.minimax.cn";
// Destination syntax only. The original owner binding selects exactly one host.
export function isMiniMaxVideoOrigin(value: unknown): boolean {
  return value === miniMaxVideoOrigins.global || value === miniMaxVideoOrigins.cn || value === miniMaxCurrentCnVideoOrigin;
}
const maxJson = 1024 * 1024;
type RegisterInput = ManagedReadContext["registerInput"];
type Json = Record<string, unknown>;
export function validateMiniMaxMediaId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) fail("id");
  return id;
}
export function prepareMiniMaxVideo(region: keyof typeof miniMaxVideoOrigins, value: unknown) {
  if (region !== "global" && region !== "cn") fail("region");
  return prepareVideoShape(region, value, false);
}
export function prepareMiniMaxInlineVideoScalars(value: unknown) {
  return prepareVideoShape("global", value, true);
}
function prepareVideoShape(region: keyof typeof miniMaxVideoOrigins, value: unknown, ownedInline: boolean) {
  const body = object(value);
  if (ownedInline && (Object.hasOwn(body, "first_frame_image") || !(miniMaxVideoModels as readonly string[]).includes(String(body.model)))) fail("inline_model");
  if (Object.keys(body).some(key => !["model", "prompt", "duration", "resolution", "first_frame_image"].includes(key))
    || typeof body.model !== "string" || !(miniMaxVideoModels as readonly string[]).includes(body.model)) fail("model_or_fields");
  const imageMode = ownedInline || body.first_frame_image !== undefined, legacy = body.model.startsWith("I2V-");
  if (!imageMode && (legacy || body.model === "MiniMax-Hailuo-2.3-Fast")) fail("requires_image");
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || body.prompt.length > 2000)
    || !imageMode && (typeof body.prompt !== "string" || !body.prompt.trim())) fail("prompt");
  if (imageMode && !ownedInline) imageReference(body.first_frame_image);
  const duration = body.duration === undefined ? 6 : body.duration, resolution = body.resolution === undefined ? legacy ? "720P" : "768P" : body.resolution;
  if (legacy ? duration !== 6 || resolution !== "720P"
    : ![6, 10].includes(Number(duration)) || typeof duration !== "number" || !["768P", "1080P"].includes(String(resolution)) || typeof resolution !== "string"
      || duration === 10 && resolution === "1080P") fail("shape");
  return { origin: miniMaxVideoOrigins[region], path: "/v1/video_generation", body, requestedVersion: body.model,
    duration, resolution, headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function prepareMiniMaxVideoControl(action: string, id: unknown) {
  if (action !== "retrieve") fail("unsupported_control");
  return { method: "GET", path: "/v1/query/video_generation", query: new URLSearchParams({ task_id: validateMiniMaxMediaId(id) }),
    headers: new Headers({ accept: "application/json" }) };
}
export function observeMiniMaxVideo(value: unknown, action: "create" | "retrieve", expectedId?: string): ManagedObservation {
  const body = object(value), id = validateMiniMaxMediaId(body.task_id);
  if (action !== "create" && action !== "retrieve" || action === "retrieve" && id !== validateMiniMaxMediaId(expectedId)) fail("job_identity");
  const status = body.status, base = object(body.base_resp);
  const failed = status === "Fail";
  if (body.error !== undefined || base.status_code !== 0 && !(failed && [1026, 1027].includes(Number(base.status_code)) && typeof base.status_code === "number")) fail("api_error");
  if (action === "create" && status === undefined) return { id, nativeStatus: null, terminal: null, body, followUp: "retrieve" };
  if (typeof status !== "string" || !["Preparing", "Queueing", "Processing", "Success", "Fail"].includes(status)) fail("status");
  const terminal = status === "Success" ? "succeeded" : failed ? "failed" : null;
  if (terminal === "succeeded") validateMiniMaxMediaId(body.file_id);
  else if (body.file_id !== undefined || body.video_url !== undefined) fail("premature_output");
  return { id, nativeStatus: status, terminal, body,
    ...(action === "create" && terminal === null ? { followUp: "retrieve" as const } : {}) };
}
export async function readMiniMaxVideo(response: Response, action: "create" | "retrieve", expectedId: string | undefined, signal: AbortSignal, register?: RegisterInput): Promise<ManagedObservation> {
  return observeMiniMaxVideo(await readJson(response, signal, "native", register), action, expectedId);
}
export function miniMaxVideoFiles(observation: ManagedObservation): readonly { id: string; mimeType: "video/mp4" }[] {
  if (observation.terminal !== "succeeded") return [];
  const checked = observeMiniMaxVideo(observation.body, "retrieve", observation.id);
  if (checked.terminal !== "succeeded") fail("file_job");
  return [{ id: validateMiniMaxMediaId(checked.body.file_id), mimeType: "video/mp4" }];
}
export function prepareMiniMaxVideoFile(action: string, selectedOrigin: string, fileId: unknown) {
  if (!isMiniMaxVideoOrigin(selectedOrigin) || !["metadata", "download"].includes(action)) fail("file_control");
  return { origin: selectedOrigin, method: "GET", path: action === "metadata" ? "/v1/files/retrieve" : "/v1/files/retrieve_content",
    query: new URLSearchParams({ file_id: validateMiniMaxMediaId(fileId) }),
    headers: new Headers({ accept: action === "metadata" ? "application/json" : "video/mp4, application/octet-stream" }) };
}
export async function readMiniMaxVideoFileState(response: Response, expectedFileId: string, signal: AbortSignal, register?: RegisterInput) {
  const body = await readJson(response, signal, "metadata", register), file = object(body.file), id = validateMiniMaxMediaId(file.file_id);
  if (object(body.base_resp).status_code !== 0 || id !== validateMiniMaxMediaId(expectedFileId)
    || file.purpose !== "video_generation" || file.bytes !== undefined && (!Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)) fail("file_metadata");
  // download_url is only an expiring hint; credentials stay at the API origin.
  const safeFile = { ...file }; delete safeFile.download_url;
  return { id, status: "active" as const, byteSize: typeof file.bytes === "number" && file.bytes > 0 ? file.bytes : null,
    body: { ...body, file: safeFile } };
}
export async function readMiniMaxVideoFile(response: Response, maxBytes: number, signal: AbortSignal, register?: RegisterInput): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > 16 * 1024 * 1024) fail("file_limit");
  const bytes = await readVideoFileBytes(response, maxBytes, signal, register);
  // The primary retrieve_content schema labels binary as application/json.
  // Never accept a JSON error or HTML as video under that misleading MIME.
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") fail("mp4");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, boxes = 0;
  while (offset < bytes.length) {
    if (++boxes > 8192 || bytes.length - offset < 8) fail("mp4");
    let size = view.getUint32(offset), header = 8;
    for (let i = offset + 4; i < offset + 8; i++) if (bytes[i] < 32 || bytes[i] > 126) fail("mp4");
    if (size === 1) {
      if (bytes.length - offset < 16) fail("mp4");
      const high = view.getUint32(offset + 8), low = view.getUint32(offset + 12);
      if (high !== 0) fail("mp4"); size = low; header = 16;
    } else if (size === 0) size = bytes.length - offset;
    if (size < header || offset === 0 && size < 16 || size > bytes.length - offset) fail("mp4");
    offset += size;
  }
  // Structural box completeness is not a playable-media or codec claim.
  return bytes;
}
export function parseMiniMaxMediaJson(text: string): Json {
  let wireBytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i), next = text.charCodeAt(i + 1);
    wireBytes += c < 128 ? 1 : c < 2048 ? 2 : c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? (i++, 4) : 3;
    if (wireBytes > maxJson) fail("json_limit");
  }
  // Preserve int64 IDs before JSON.parse can round them. Only object-key
  // number tokens named task_id/file_id are normalized; string content is inert.
  const parts: string[] = []; let copied = 0, replacements = 0, units = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const start = index++;
    for (; index < text.length; index++) { if (text[index] === "\\") index++; else if (text[index] === '"') break; }
    if (index >= text.length) fail("json");
    const token = text.slice(start, index + 1);
    let key: unknown; try { key = JSON.parse(token); } catch { fail("json"); }
    if (key !== "file_id" && key !== "task_id") continue;
    let cursor = index + 1; while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (text[cursor++] !== ":") continue;
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    const first = cursor; while (/[0-9]/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (cursor === first || !/[\s,}\]]/.test(text[cursor] ?? "")) continue;
    const raw = text.slice(first, cursor); validateMiniMaxMediaId(raw);
    if (++replacements > 4096 || (units += first - copied + raw.length + 2) > maxJson + 8192) fail("json_limit");
    parts.push(text.slice(copied, first), `"${raw}"`); copied = cursor; index = cursor - 1;
  }
  if (units + text.length - copied > maxJson + 8192) fail("json_limit");
  parts.push(text.slice(copied));
  try { return object(JSON.parse(parts.join(""))); } catch { fail("json"); }
}
async function readJson(response: Response, signal: AbortSignal, profile: "native" | "metadata", register?: RegisterInput): Promise<Json> {
  let input: InputRetirement | undefined;
  try {
    return object(await readVideoJson(response, signal, profile, (owner, source) => {
      input = owner;
      if (!(source instanceof Response)) fail("response");
      register?.(owner, source);
    }, parseMiniMaxMediaJson));
  } catch {
    if (!register) await input?.retired.catch(() => undefined);
    fail("response");
  }
}
function imageReference(value: unknown): void {
  if (typeof value !== "string" || value.length > 12 * 1024 * 1024) fail("image");
  const data = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (data) {
    const encoded = data[1]; let raw: string;
    try { raw = atob(encoded); } catch { fail("image"); }
    if (!raw.length || raw.length > 8 * 1024 * 1024 || encoded.length % 4 || btoa(raw) !== encoded) fail("image");
    return;
  }
  let url: URL; try { url = new URL(value); } catch { fail("image"); }
  if (value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) fail("image");
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function fail(reason: string): never { throw new Error(`invalid_minimax_video_${reason}`); }

