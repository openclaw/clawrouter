import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { validateVydraJobId } from "./vydra-jobs.ts";

export const vydraModels = ["grok-imagine", "veo3", "kling", "elevenlabs/tts"] as const;
export type VydraModel = typeof vydraModels[number];
type Json = Record<string, unknown>;
const encoder = new TextEncoder(), maxEnvelope = 1024 * 1024;
export interface VydraModelRequest { model: VydraModel; kind: "image" | "video" | "audio"; path: string; body: Json; headers: Headers }
export function prepareVydraModel(model: string, value: unknown): VydraModelRequest {
  if (!(vydraModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const kind = model === "grok-imagine" ? "image" : model === "elevenlabs/tts" ? "audio" : "video";
  const allowed = kind === "audio" ? ["text", "voice_id"] : model === "kling" ? ["prompt", "image_url", "video_url"]
    : kind === "image" ? ["prompt", "model"] : ["prompt"];
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields");
  const text = kind === "audio" ? value.text : value.prompt;
  if (typeof text !== "string" || !text.trim() || text.length > (kind === "audio" ? 10000 : kind === "image" ? 5000 : 2000)
    || encoder.encode(text).length > (kind === "audio" ? 40000 : 4000)) fail("text");
  for (const character of text) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (kind === "image" && value.model !== "text-to-image") fail("image_mode");
  if (kind === "audio" && (typeof value.voice_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.voice_id))) fail("voice");
  if (model === "kling") {
    const image = assetUrl(value.image_url), video = assetUrl(value.video_url);
    // Frozen OpenClaw supplied the same image twice. The native contract needs
    // an actual motion video; do not silently reinterpret that legacy request.
    if (image === video) fail("motion_reference");
  }
  return { model: model as VydraModel, kind, path: "/api/v1/models/" + model, body: structuredClone(value),
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export interface VydraModelObservation {
  body: Json; id?: string; nativeStatus: string | null; terminal: "succeeded" | "failed" | "canceled" | null;
  assets: readonly { url: string; kind: VydraModelRequest["kind"] }[];
  chargedLedgerUnits: number | null; refundedLedgerUnits: number | null; refundStatus: string | null; upstreamCostMicros: null;
}
export function observeVydraModel(value: unknown, request: Pick<VydraModelRequest, "model" | "kind">,
  action: "create" | "retrieve", expectedId?: string): VydraModelObservation {
  if (!mediaObject(value) || encoder.encode(JSON.stringify(value)).length > maxEnvelope || value.success === false) fail("response");
  const id = value.jobId === undefined && value.id === undefined ? undefined : validateVydraJobId(value.jobId ?? value.id);
  if (value.jobId !== undefined && value.id !== undefined && value.jobId !== value.id) fail("ambiguous_id");
  if (action === "retrieve" && (!expectedId || id !== validateVydraJobId(expectedId))
    || action === "create" && expectedId !== undefined) fail("identity");
  if (request.kind === "video" && !id) fail("job_id");
  if (value.model !== undefined && value.model !== request.model) fail("model");
  const status = value.status ?? null;
  if (status !== null && !["pending", "running", "completed", "failed", "cancelled"].includes(String(status))) fail("status");
  if (status !== null && typeof status !== "string" || status === null && request.kind === "video") fail("status");
  if (value.error != null && status !== "failed") fail("error");
  const terminal = status === "failed" ? "failed" : status === "cancelled" ? "canceled"
    : status === "completed" || status === null && request.kind !== "video" ? "succeeded" : null;
  // Partial URLs are not successful generation, nor a reason to stop polling.
  const assets = terminal === "succeeded" ? extractAssets(value, request.kind) : [];
  if (terminal === "succeeded" && !assets.length && request.kind !== "video") fail("missing_output");
  if (terminal === null && !id) fail("job_id");
  const refundStatus = value.refundStatus ?? null;
  if (refundStatus !== null && (typeof refundStatus !== "string" || !/^[a-z_]{1,64}$/.test(refundStatus))) fail("refund");
  return { body: value, ...(id ? { id } : {}), nativeStatus: status as string | null, terminal, assets,
    chargedLedgerUnits: units(value.creditsCharged), refundedLedgerUnits: units(value.creditsRefunded), refundStatus, upstreamCostMicros: null };
}

export async function readVydraModel(response: Response, request: Pick<VydraModelRequest, "model" | "kind">,
  action: "create" | "retrieve", signal: AbortSignal, expectedId?: string): Promise<VydraModelObservation> {
  const allowed = action === "create" && request.kind === "video" ? [200, 202] : [200];
  if (response.redirected || !allowed.includes(response.status)) { void response.body?.cancel().catch(() => undefined); fail("http"); }
  // Preserve the stream and its length/range headers while using the common
  // strict JSON reader for the documented 202 create envelope.
  const normalized = response.status === 202 ? new Response(response.body, { status: 200, headers: response.headers }) : response;
  return readNativeJson(normalized, signal, maxEnvelope, value => observeVydraModel(value, request, action, expectedId), fail);
}

function extractAssets(body: Json, kind: VydraModelRequest["kind"]): { url: string; kind: VydraModelRequest["kind"] }[] {
  const urls = new Set<string>(), urlKeys = [kind + "Url", kind + "Urls", "resultUrl", "resultUrls", "outputUrl", "outputUrls", "url", "urls"];
  let nodes = 0;
  const add = (value: unknown, depth: number) => {
    if (++nodes > 256 || depth > 5) fail("output_limit");
    if (Array.isArray(value)) { if (value.length > 16) fail("output_limit"); for (const item of value) add(item, depth + 1); }
    else { urls.add(assetUrl(value)); if (urls.size > 8) fail("output_limit"); }
  };
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 256 || depth > 5) fail("output_limit");
    if (Array.isArray(value)) { if (value.length > 16) fail("output_limit"); for (const item of value) visit(item, depth + 1); return; }
    if (!mediaObject(value)) return;
    for (const key of urlKeys) if (value[key] !== undefined) add(value[key], depth);
    for (const key of ["output", "outputs", "result", "results", "data", "asset", "assets"]) if (value[key] !== undefined) visit(value[key], depth + 1);
  };
  visit(body, 0);
  return [...urls].map(url => ({ url, kind }));
}
function assetUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\]/.test(value)) fail("asset_url");
  let url: URL; try { url = new URL(value); } catch { fail("asset_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("asset_url");
  // This is only an opaque descriptor. Runtime/consumer must qualify DNS,
  // ownership, redirect policy, bytes and MIME before any credential-free read.
  return value;
}
function units(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("ledger_units");
  return value;
}
function fail(reason: string): never { throw new Error("invalid_vydra_model_" + reason); }
