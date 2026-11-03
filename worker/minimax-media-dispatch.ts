import { inspectGrantCredentials } from "./grant-credentials.ts";
import { miniMaxApiKeySecret, miniMaxEnvironmentBinding, miniMaxMediaProjection } from "./native-media-credential.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

const denied = () => new HttpError(403, "native_media_authorization_required", "Global MiniMax speech requires unchanged original credential authorization");
function ownerIdentity(grant: UpstreamGrant): string {
  if (!miniMaxMediaProjection(grant) || !Number.isSafeInteger(grant.credentialGeneration) || !grant.credentialLineage) throw denied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.nativeMediaBinding]);
}

// Prepared only for this qualified product. No credential refresh or selection
// occurs here. The returned check runs after every other pre-dispatch await.
export async function prepareMiniMaxMediaDispatch(
  selection: ProxySelection, env: Env, upstream: UpstreamAuth, destination: URL, headers: Headers,
): Promise<((signal: AbortSignal) => Promise<void>) | undefined> {
  if (selection.endpoint.request_format !== "minimax.speech") return;
  const scheme = selection.provider.auth.schemes.find(value => value.type !== "oauth");
  if (selection.provider.id !== "minimax" || upstream.baseUrl !== "https://api.minimax.io"
    || destination.href !== "https://api.minimax.io/v1/t2a_v2" || upstream.transport !== null
    || scheme?.type !== "bearer" || scheme.header.toLowerCase() !== "authorization"
    || scheme.format !== "Bearer ${secret}" || scheme.secretKind !== "api_key" || [...upstream.query].length) throw denied();
  const key = upstream.grantKey;
  if (key !== null) {
    const grant = upstream.grant;
    if (!grant) throw denied();
    const identity = ownerIdentity(grant), secret = miniMaxApiKeySecret(grant);
    if (!secret || headers.get("authorization") !== `Bearer ${secret}`) throw denied();
    return async signal => {
      signal.throwIfAborted();
      // /inspect reads the credential owner, not KV, admission or credential caches.
      // Generation must equal the already selected revision; materialize's
      // expectedGeneration is deliberately not used as an equality check.
      const current = await inspectGrantCredentials(env, key, signal);
      signal.throwIfAborted();
      if (ownerIdentity(current) !== identity) throw denied();
    };
  }
  if (upstream.grant !== null) throw denied();
  const selected = miniMaxEnvironmentBinding(selection.provider, env);
  if (!selected || headers.get("authorization") !== `Bearer ${selected.secret}`
    || await sha256Hex(selected.secret) !== selected.fingerprint) throw denied();
  const routeIdentity = JSON.stringify(["clawrouter.minimax-media-route.v1", destination.href,
    "MINIMAX_API_KEY", selected.binding, selected.fingerprint]);
  return async signal => {
    signal.throwIfAborted();
    const current = miniMaxEnvironmentBinding(selection.provider, env);
    if (!current) throw denied();
    const fingerprint = await sha256Hex(current.secret);
    signal.throwIfAborted();
    // Compare after hashing too: a test or server configuration rotation during
    // the await cannot qualify bytes selected by the previous preparation.
    const final = miniMaxEnvironmentBinding(selection.provider, env);
    if (!final || final.secret !== current.secret || final.binding !== current.binding
      || fingerprint !== current.fingerprint || routeIdentity !== JSON.stringify([
        "clawrouter.minimax-media-route.v1", destination.href, "MINIMAX_API_KEY", final.binding, fingerprint])) throw denied();
  };
}
