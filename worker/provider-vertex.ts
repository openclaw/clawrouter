export const vertexTokenUrl = "https://oauth2.googleapis.com/token";
export const vertexScope = "https://www.googleapis.com/auth/cloud-platform";
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function requireVertex(condition: unknown, field: string): asserts condition { if (!condition) throw new Error(`invalid_vertex_${field}`); }
function seconds(now: number) { requireVertex(Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - 3600, "time"); return now; }
function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function importVertexServiceAccountKey(pem: string): Promise<CryptoKey> {
  requireVertex(pem.length <= 16_384 && /^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END PRIVATE KEY-----\s*$/.test(pem), "private_key");
  try {
    const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    return await crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch { throw new Error("invalid_vertex_private_key"); }
}

// Run under the credential owner's refresh lifecycle, never on the warm proxy
// path. This flow does not impersonate a user or discover credentials from a host.
export async function createVertexAssertion(clientEmail: string, privateKey: CryptoKey, now: number, keyId?: string): Promise<string> {
  seconds(now);
  requireVertex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(clientEmail) && clientEmail.length <= 254, "service_account");
  requireVertex(keyId === undefined || /^[a-zA-Z0-9_-]{1,128}$/.test(keyId), "key_id");
  const algorithm = record(privateKey.algorithm), hash = record(algorithm?.hash);
  requireVertex(privateKey.type === "private" && algorithm?.name === "RSASSA-PKCS1-v1_5" && hash?.name === "SHA-256" && typeof algorithm.modulusLength === "number" && algorithm.modulusLength >= 2048 && privateKey.usages.includes("sign"), "signing_key");
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...(keyId ? { kid: keyId } : {}) })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: clientEmail, scope: vertexScope, aud: vertexTokenUrl, iat: now, exp: now + 3600 })));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export function vertexTokenRequest(assertion: string): Request {
  requireVertex(assertion.length <= 16_384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(assertion), "assertion");
  return new Request(vertexTokenUrl, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
}

export interface VertexAccessToken { accessToken: string; expiresAt: number }
const bearerToken = (value: unknown): value is string => typeof value === "string" && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
export function decodeVertexAccessToken(value: unknown, requestedAt: number): VertexAccessToken {
  seconds(requestedAt);
  const response = record(value);
  requireVertex(response && bearerToken(response.access_token) && response.token_type === "Bearer" && Number.isSafeInteger(response.expires_in) && (response.expires_in as number) > 0 && (response.expires_in as number) <= 3600, "token_response");
  requireVertex(response.scope === undefined || (typeof response.scope === "string" && response.scope.split(/\s+/).includes(vertexScope)), "token_scope");
  return { accessToken: response.access_token, expiresAt: requestedAt + (response.expires_in as number) };
}

export interface VertexBinding { project: string; location: string }
export function vertexAnthropicUrl(binding: VertexBinding, selectedModel: string, stream: boolean): string {
  requireVertex(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/.test(binding.project), "project");
  requireVertex(/^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$/.test(binding.location), "location");
  requireVertex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,199}$/.test(selectedModel), "model");
  const host = binding.location === "global" ? "aiplatform.googleapis.com" : binding.location === "us" || binding.location === "eu"
    ? `aiplatform.${binding.location}.rep.googleapis.com` : `${binding.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${binding.project}/locations/${binding.location}/publishers/anthropic/models/${encodeURIComponent(selectedModel)}:${stream ? "streamRawPredict" : "rawPredict"}`;
}

export function prepareVertexAnthropicRequest(value: unknown, binding: VertexBinding, selectedModel: string, token: VertexAccessToken, now: number): Request {
  seconds(now);
  requireVertex(bearerToken(token.accessToken) && Number.isSafeInteger(token.expiresAt) && token.expiresAt > now + 60, "expired_token");
  const body = record(value);
  requireVertex(body && Array.isArray(body.messages) && Number.isSafeInteger(body.max_tokens) && (body.max_tokens as number) > 0 && (body.stream === undefined || typeof body.stream === "boolean"), "messages");
  requireVertex(body.anthropic_version === undefined || body.anthropic_version === "vertex-2023-10-16", "version");
  const { model: _model, ...native } = body;
  return new Request(vertexAnthropicUrl(binding, selectedModel, body.stream === true), { method: "POST", redirect: "manual",
    headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...native, anthropic_version: "vertex-2023-10-16" }) });
}
