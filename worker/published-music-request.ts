import type { PublishedInputBinding } from "./published-input-receipt.ts";
import { sha256Hex } from "./utils.ts";

export const publishedMusicBodyBytes = 256 * 1024;
export const publishedMusicDispatchBytes = 640 * 1024;
export const publishedMusicDispatchHeader = "x-clawrouter-private-asset-dispatch";

export async function publishedMusicRequestDigest(body: Record<string, unknown>, image: Pick<PublishedInputBinding, "digest" | "mime" | "size" | "slot">): Promise<string> {
  // The codec has already qualified every native field. The image slot is
  // replaced semantically, so the eventual verifier URL is not self-referential
  // and never enters the stored request digest input as a bearer credential.
  const message = (body.messages as { role: string; content: { text?: string }[] }[])[0];
  return sha256Hex(JSON.stringify(["clawrouter.published-music-request.v1", body.model, body.stream, body.modalities,
    (body.audio as { format: string }).format, message.role, message.content[0].text, image.slot, image.digest, image.mime, image.size]));
}

export function publishedMusicReference(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || !Array.isArray(messages[0]?.content)) return;
  const url = messages[0].content[1]?.image_url?.url;
  return typeof url === "string" && url.startsWith("https:") ? url : undefined;
}
