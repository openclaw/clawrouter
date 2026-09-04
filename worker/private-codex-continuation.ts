import type { PrivatePolicy, PrivateUpstream } from "./private-codex-config";

const prefix = "cr1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PrivateContinuationProjection { wrap(value: unknown): Promise<string> }

// Bind original upstream state to its route without revealing the target. This
// envelope never replaces upstream verification of its own restored state.
export async function privateContinuations(policy: PrivatePolicy, upstream: PrivateUpstream) {
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode("clawrouter:continuation:v1\0" + upstream.accessToken)), "AES-GCM", false, ["encrypt", "decrypt"]);
  const additionalData = encoder.encode(JSON.stringify([policy, upstream.target, upstream.fallbackTarget, upstream.accountId]));

  async function unwrap(value: string): Promise<{ slot: number; value: string }> {
    if (!value.startsWith(prefix)) return { slot: 0, value };
    if (value.length > 8192) throw new Error("private continuation limit");
    const sealed = decode(value.slice(prefix.length));
    if (sealed.length < 30) throw new Error("private continuation invalid");
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData }, key, sealed.slice(12)));
    if (plain.length < 2 || plain[0] > 1) throw new Error("private continuation invalid");
    return { slot: plain[0], value: decoder.decode(plain.slice(1)) };
  }

  return {
    async request(body: Record<string, unknown>, headers: Headers) {
      const previous = body.previous_response_id;
      const affinity = headers.get("x-codex-turn-state");
      if (previous != null && typeof previous !== "string") throw new Error("private continuation invalid");
      const responseState = typeof previous === "string" && previous ? await unwrap(previous) : null;
      const turnState = affinity !== null ? await unwrap(affinity) : null;
      if (responseState && turnState && responseState.slot !== turnState.slot) throw new Error("private continuation mismatch");
      const outgoing = new Headers(headers);
      if (turnState) outgoing.set("x-codex-turn-state", turnState.value);
      return {
        slot: responseState?.slot ?? turnState?.slot ?? 0,
        body: responseState ? { ...body, previous_response_id: responseState.value } : body,
        headers: outgoing,
        continuing: !!responseState || !!turnState,
      };
    },
    async projection(slot: number): Promise<PrivateContinuationProjection> {
      const cache = new Map<string, Promise<string>>();
      async function seal(value: string): Promise<string> {
        const raw = encoder.encode(value);
        const plain = new Uint8Array(1 + raw.length); plain[0] = slot; plain.set(raw, 1);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plain));
        const token = new Uint8Array(iv.length + sealed.length); token.set(iv); token.set(sealed, iv.length);
        const wrapped = prefix + encode(token);
        if (wrapped.length > 8192) throw new Error("private continuation limit");
        return wrapped;
      }
      return { async wrap(value: unknown): Promise<string> {
        if (typeof value !== "string" || !value || value.length > 8192) throw new Error("private continuation invalid");
        const existing = cache.get(value);
        if (existing) return existing;
        if (cache.size >= 128) throw new Error("private continuation count");
        const wrapped = seal(value); cache.set(value, wrapped);
        return wrapped;
      } };
    },
  };
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("private continuation invalid");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("private continuation invalid");
  return bytes;
}
