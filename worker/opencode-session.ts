import { correlationMetadata } from "./correlation.ts";
import { continuationScope } from "./http-continuation.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

const standalone = new WeakMap<Request, string>();
const formats = new Set(["openai.chat_completions", "openai.responses", "anthropic.messages"]);
export const openCodeSessionHeaders = ["x-opencode-session", "x-clawrouter-session-id", "x-claude-code-session-id", "session-id"] as const;
const headerName = openCodeSessionHeaders[0];

// This is an attribution handle, never authority to select or revive a grant.
// Inputs are the authenticated caller and already materialized original route.
export async function openCodeSessionHeader(
  request: Request, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, destination: URL,
): Promise<Readonly<{ name: "x-opencode-session"; value: string }> | null> {
  const provider = selection.provider.id;
  if (provider !== "opencode" && provider !== "opencode-go") return null;
  if (selection.method !== "POST" || !formats.has(selection.endpoint.request_format)
    || selection.endpoint.response_format !== selection.endpoint.request_format) return null;
  const base = new URL(upstream.baseUrl);
  if (base.origin !== "https://opencode.ai" || destination.origin !== base.origin
    || base.username || base.password || base.search || base.hash || destination.username || destination.password || destination.hash)
    throw new HttpError(400, "invalid_opencode_session_destination", "OpenCode session binding requires its configured native origin");
  let credential: readonly unknown[];
  if (upstream.grantKey !== null) {
    if (!upstream.grant?.credentialLineage)
      throw new HttpError(503, "opencode_session_owner_unavailable", "original upstream credential ownership is unavailable");
    credential = ["grant", upstream.grantKey, upstream.grant.credentialLineage];
  } else {
    if (upstream.grant) throw new HttpError(503, "opencode_session_owner_unavailable", "original upstream credential ownership is unavailable");
    // Same materialized-credential fingerprint pattern as response ownership.
    // Ignore static session overrides: they cannot choose the derived identity.
    credential = ["environment", await sha256Hex(JSON.stringify([
      [...upstream.headers].filter(([name]) => !openCodeSessionHeaders.some(value => value === name.toLowerCase())), [...upstream.query],
    ]))];
  }
  const conversation = correlationMetadata(request).sessionId;
  let identity: readonly string[];
  if (conversation !== null) identity = ["conversation", conversation];
  else {
    let nonce = standalone.get(request);
    if (!nonce) { nonce = crypto.randomUUID(); standalone.set(request, nonce); }
    identity = ["standalone", nonce];
  }
  const value = await sha256Hex(JSON.stringify([
    "clawrouter.opencode-session.v1", await continuationScope(auth), provider, destination.origin, credential, identity,
  ]));
  return { name: headerName, value: `crs_${value}` };
}
