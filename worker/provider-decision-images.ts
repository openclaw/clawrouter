import { decisionRecord, requireDecision } from "./provider-decision-wire.ts";

export type DecisionImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type LiquidImage = string | { content_type: DecisionImageMime; base64: string };
export interface TypeSafeImage { type: "image"; format: "png" | "jpg" | "jpeg"; data_base64: string }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Check the wire and signature without decoding or retaining a second full image.
// Pixel decoding, dimensions and model vision eligibility remain upstream checks.
export function decisionImageBytes(data: unknown, mime: unknown): number {
  requireDecision(typeof data === "string" && data.length > 0 && data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3) && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data), "image_base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  requireDecision(!padding || (alphabet.indexOf(data[data.length - padding - 1]) & (padding === 2 ? 15 : 3)) === 0, "image_base64");
  const bytes = data.length / 4 * 3 - padding;
  requireDecision(bytes <= 4 * 1024 * 1024, "image_bytes");
  const prefix = atob(data.slice(0, Math.min(data.length, 24)));
  const signature = mime === "image/png" ? prefix.startsWith("\x89PNG\r\n\x1a\n")
    : mime === "image/jpeg" ? prefix.startsWith("\xff\xd8\xff")
    : mime === "image/webp" ? prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP"
    : mime === "image/gif" ? ["GIF87a", "GIF89a"].includes(prefix.slice(0, 6)) : false;
  requireDecision(signature, "image_media_type");
  return bytes;
}
export function decisionImageUri(value: unknown, allowed: readonly DecisionImageMime[]): void {
  requireDecision(typeof value === "string", "image_uri");
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(value);
  requireDecision(match && allowed.includes(match[1] as DecisionImageMime), "image_uri");
  decisionImageBytes(value.slice(match[0].length), match[1]);
}
export function validateLiquidImages(value: unknown): asserts value is LiquidImage[] {
  requireDecision(Array.isArray(value) && value.length >= 1 && value.length <= 8, "liquid_images");
  for (const image of value) {
    if (typeof image === "string") decisionImageUri(image, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
    else {
      const object = decisionRecord(image);
      requireDecision(object && Object.keys(object).every(key => ["content_type", "base64"].includes(key)), "liquid_image");
      decisionImageBytes(object.base64, object.content_type);
    }
  }
}
function references(value: unknown, placeholder: string): boolean {
  if (typeof value === "string") return value.includes(placeholder);
  return value !== null && typeof value === "object" && Object.values(value).some(value => references(value, placeholder));
}
export function validateTypeSafeImages(value: unknown, state: unknown, questions: unknown): asserts value is Record<string, TypeSafeImage> {
  const assets = decisionRecord(value);
  requireDecision(assets && Object.keys(assets).length > 0, "typesafe_assets");
  for (const [id, value] of Object.entries(assets)) {
    const asset = decisionRecord(value);
    requireDecision(id.length && asset?.type === "image" && ["png", "jpg", "jpeg"].includes(asset.format as string) && Object.keys(asset).every(key => ["type", "format", "data_base64"].includes(key)), "typesafe_image");
    requireDecision(references(state, id) || references(questions, id), "typesafe_image_reference");
    requireDecision(!Object.keys(assets).some(other => other !== id && other.includes(id)), "typesafe_image_reference_overlap");
    decisionImageBytes(asset.data_base64, asset.format === "png" ? "image/png" : "image/jpeg");
  }
}
