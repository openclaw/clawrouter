import { readNativeJson } from "./native-json.ts";
import { mediaObject } from "./managed-media-json.ts";

export const miniMaxImageModel = "image-01";
export const miniMaxImagePath = "/v1/image_generation";
const origins = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;
const aspects = new Set(["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"]);
const encoder = new TextEncoder(), maxImage = 8 * 1024 * 1024, maxImages = 16 * 1024 * 1024, maxEnvelope = 24 * 1024 * 1024;
type Json = Record<string, unknown>;
export interface MiniMaxImageRequest { origin: string; path: typeof miniMaxImagePath; body: Json; count: number; headers: Headers }
export interface MiniMaxImageObservation {
  body: Json; model: typeof miniMaxImageModel; images: Uint8Array[];
  delivery: "complete" | "partial" | "filtered"; successCount: number; failedCount: number;
  upstreamCostMicros: null;
}
export function prepareMiniMaxImage(region: keyof typeof origins, value: unknown): MiniMaxImageRequest {
  if (region !== "global" && region !== "cn") fail("region");
  const body = object(value); keys(body, ["model", "prompt", "response_format", "n", "aspect_ratio", "subject_reference"]);
  if (body.model !== miniMaxImageModel || typeof body.prompt !== "string" || !body.prompt.trim()
    || body.prompt.length > 1500 || !wellFormed(body.prompt) || body.response_format !== "base64"
    || !Number.isSafeInteger(body.n) || Number(body.n) < 1 || Number(body.n) > 9) fail("request");
  if (body.aspect_ratio !== undefined && (typeof body.aspect_ratio !== "string" || !aspects.has(body.aspect_ratio))) fail("aspect");
  if (body.subject_reference !== undefined) {
    if (!Array.isArray(body.subject_reference) || body.subject_reference.length !== 1) fail("reference");
    const reference = object(body.subject_reference[0]); keys(reference, ["type", "image_file"]);
    if (reference.type !== "character" || typeof reference.image_file !== "string") fail("reference");
    if (reference.image_file.startsWith("data:")) {
      const data = /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/.exec(reference.image_file);
      if (!data) fail("reference"); bytes(data[1]);
    } else {
      let url: URL; try { url = new URL(reference.image_file); } catch { fail("reference_url"); }
      if (reference.image_file.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) fail("reference_url");
      // Opaque native input only. The router never fetches this destination.
    }
  }
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope) fail("request_size");
  return { origin: origins[region], path: miniMaxImagePath, body, count: Number(body.n),
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function observeMiniMaxImage(value: unknown, request: MiniMaxImageRequest, complete: boolean): MiniMaxImageObservation {
  const body = object(value);
  if (!complete || encoder.encode(JSON.stringify(body)).length > maxEnvelope || body.error !== undefined
    || !mediaObject(body.base_resp) || body.base_resp.status_code !== 0
    || body.model !== undefined && body.model !== miniMaxImageModel) fail("response");
  const data = object(body.data), metadata = object(body.metadata);
  if (data.image_urls !== undefined && (!Array.isArray(data.image_urls) || data.image_urls.length !== 0)
    || !Array.isArray(data.image_base64) || data.image_base64.length > request.count) fail("images");
  const successCount = count(metadata.success_count), failedCount = count(metadata.failed_count);
  if (successCount !== data.image_base64.length || successCount + failedCount !== request.count) fail("counts");
  let total = 0;
  const images = data.image_base64.map(value => {
    const image = bytes(value); total += image.length; if (total > maxImages) fail("output_size"); return image;
  });
  return { body, model: miniMaxImageModel, images, successCount, failedCount,
    delivery: failedCount === 0 ? "complete" : successCount === 0 ? "filtered" : "partial",
    upstreamCostMicros: null };
}
export async function readMiniMaxImage(response: Response, request: MiniMaxImageRequest, signal: AbortSignal): Promise<MiniMaxImageObservation> {
  return readNativeJson(response, signal, maxEnvelope, body => observeMiniMaxImage(body, request, true), fail);
}
function count(value: unknown): number {
  // Official schema uses integers; its wire examples also use decimal strings.
  const number = typeof value === "string" && /^[0-9]$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 9) fail("count");
  return number;
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxImage / 3) * 4
    || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("base64");
  let raw: string; try { raw = atob(value); } catch { fail("base64"); }
  if (!raw.length || raw.length > maxImage || btoa(raw) !== value) fail("base64");
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function wellFormed(value: string): boolean {
  return ![...value].some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_minimax_image_${reason}`); }

