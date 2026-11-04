import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { continuationScope } from "./http-continuation.ts";
import { freezeInlineMusicInput, readInlineMusicJson } from "./openrouter-music-input.ts";
import { imageEvidence } from "./openrouter-music-runtime.ts";
import { musicPolicyBinding } from "./openrouter-music-owner.ts";
import { prepareOpenRouterMusicBorrowed } from "./openrouter-music.ts";
import { prepareNativeRequest, type ProxySelection } from "./proxy-selection.ts";
import { authenticateProxyKey } from "./proxy-auth.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { assertProviderAccess, providerById, upstreamAuth } from "./providers.ts";
import { authorizePublishedInputOwner, issuedPublishedInputCaller, publishedInputPermission, publishedMusicRoute,
  publishedMusicRouteDigest, assertPublishedInputGrant } from "./published-input-authority.ts";
import { publishedInputCall, publishedInputResponse, publishedInputUrl, publishInputBytes, resolvePublishedInputUrl,
  type PublishedInputAccess } from "./published-input-archive.ts";
import { assertPublishedInputLive, publishedInputLifetimeMs, publishedInputUnavailable, samePublishedInput,
  type PublishedInputBinding, type PublishedInputReceipt } from "./published-input-receipt.ts";
import type { Env } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

export async function publishedMusicRequestDigest(body: Record<string, unknown>, image: Pick<PublishedInputBinding, "digest" | "mime" | "size" | "slot">): Promise<string> {
  // The codec has already qualified every native field. The image slot is
  // replaced semantically, so the eventual verifier URL is not self-referential
  // and never enters the stored request digest input as a bearer credential.
  const message = (body.messages as { role: string; content: { text?: string }[] }[])[0];
  return sha256Hex(JSON.stringify(["clawrouter.published-music-request.v1", body.model, body.stream, body.modalities,
    (body.audio as { format: string }).format, message.role, message.content[0].text, image.slot, image.digest, image.mime, image.size]));
}

export function publishedMusicAccess(env: Env, binding: PublishedInputBinding, operation: HttpOperation, admittedPolicy?: string): PublishedInputAccess {
  return { binding, operation,
    async authorize() {
      const current = await authorizePublishedInputOwner(env, binding, operation.signal);
      if (admittedPolicy !== undefined && musicPolicyBinding(current.policy) !== admittedPolicy) publishedInputUnavailable();
    },
    assertLive() { operation.signal.throwIfAborted(); assertPublishedInputLive(binding); if (env.CLAWROUTER_PUBLIC_ORIGIN !== binding.publicOrigin) publishedInputUnavailable(); },
  };
}

// Dedicated authenticated publication intake. It selects no arbitrary provider,
// URL, endpoint or asset slot and makes no paid generation request.
export async function publishMusicInput(request: Request, env: Env): Promise<Response> {
  const provider = providerById("openrouter"), endpoint = provider?.endpoints.find(value => value.id === "music_generate");
  const providers = provider ? [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }] : [];
  const initial = await authenticateProxyKey(request.headers, env, providers);
  if (initial instanceof Response) { await request.body?.cancel().catch(() => undefined); return initial; }
  if (!provider || !endpoint || request.method !== "POST" || new URL(request.url).search) publishedInputUnavailable();
  const idempotency = request.headers.get("Idempotency-Key");
  if (!idempotency || idempotency.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(idempotency))
    throw new HttpError(400, "invalid_idempotency_key", "publication requires one bounded stable Idempotency-Key");
  const operation = new HttpOperation(request.signal, 30_000);
  let lease: BodyLease | undefined, body: Record<string, unknown> | undefined, selection: ProxySelection | undefined;
  try {
    const parsed = await readInlineMusicJson(request, operation);
    lease = parsed.lease;
    const prepared = prepareNativeRequest(provider, endpoint, parsed.value, "/v1/chat/completions", env);
    parsed.value = undefined;
    if (!prepared.model || Array.isArray(prepared.body)) publishedInputUnavailable();
    body = prepared.body; prepared.body = {};
    freezeInlineMusicInput(body); prepareOpenRouterMusicBorrowed(prepared.model.upstream, body);
    selection = { provider, endpoint, model: prepared.model, body, pathParams: prepared.pathParams, capability: "music.generate", method: "POST" };
    const auth = await authenticateProxyKey(request.headers, env, providers, false, undefined,
      { providerId: provider.id, endpointId: endpoint.id, model: prepared.model.upstream, catalogModelId: prepared.model.id, capability: "music.generate", mode: "http" }, "authoritative");
    if (auth instanceof Response) return auth;
    if (auth.credentialId !== initial.credentialId || auth.principalId !== initial.principalId || auth.policyId !== initial.policyId
      || auth.policy.tenantId !== initial.policy.tenantId) publishedInputUnavailable();
    assertPolicyModel(auth.policy, selection);
    await assertProviderAccess(provider, auth, env);
    const permission = await publishedInputPermission(auth.policy, endpoint.id, prepared.model.id);
    const upstream = await upstreamAuth(provider, auth, env, new Set(), null, true, undefined,
      { provider, endpoint, mode: "http", model: prepared.model.upstream });
    const grant = upstream.grant;
    if (!upstream.grantKey || !grant || !grant.credential || upstream.transport !== null || upstream.query.size
      || upstream.baseUrl !== "https://openrouter.ai/api" || !safeEqual(upstream.headers.get("authorization") ?? "", `Bearer ${grant.credential}`)) publishedInputUnavailable();
    const scope = await continuationScope(auth), issuer = issuedPublishedInputCaller(auth), allocatedAt = Date.now();
    const issuerExpiry = issuer.proof.kind === "proxy_key" ? issuer.proof.expiresAt ? Date.parse(issuer.proof.expiresAt) : Infinity : issuer.proof.expiresAtMs;
    const expiresAt = Math.min(allocatedAt + publishedInputLifetimeMs, permission.expiresAt, issuerExpiry, grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity);
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const idempotencyDigest = await sha256Hex(idempotency), verifierDigest = await sha256Hex(verifier);
    let result: { url: string; expiresAt: string; receiptId: string } | undefined;
    await imageEvidence((body.messages as { content: unknown }[])[0].content, operation.signal, async (evidence, bytes) => {
      const binding: PublishedInputBinding = { version: "clawrouter.published-input.v1", id: `asset_${(await sha256Hex(`${scope}:${idempotencyDigest}`)).slice(0, 32)}`,
        scope, issuer, owner: { providerId: "openrouter", endpointId: endpoint.id, grantKey: upstream.grantKey!, lineage: grant.credentialLineage!,
          routeSha256: "", policyGeneration: auth.policy.generation }, generation: grant.credentialGeneration!, publicOrigin: env.CLAWROUTER_PUBLIC_ORIGIN ?? "",
        origin: "https://openrouter.ai", path: "/api/v1/chat/completions", modelId: prepared.model!.id,
        upstreamModel: prepared.model!.upstream as PublishedInputBinding["upstreamModel"], slot: evidence.slot,
        digest: evidence.sha256, mime: evidence.mime, size: evidence.bytes, requestDigest: "", permissionDigest: permission.digest,
        idempotencyDigest, verifierDigest, allocatedAt, expiresAt };
      binding.owner.routeSha256 = await publishedMusicRouteDigest(binding);
      binding.requestDigest = await publishedMusicRequestDigest(body!, binding);
      assertPublishedInputLive(binding); assertPublishedInputGrant(binding, grant); publishedMusicRoute(binding);
      const access = publishedMusicAccess(env, binding, operation);
      await access.authorize();
      const ack = await publishedInputCall<{ acknowledged: true; receipt: PublishedInputReceipt }>(env, scope, { action: "asset_allocate", binding }, operation.signal);
      if (ack.acknowledged !== true || !samePublishedInput(ack.receipt.binding, binding) || ack.receipt.state !== "pending") publishedInputUnavailable();
      await publishInputBytes(env, access, bytes);
      await access.authorize(); access.assertLive();
      result = { url: publishedInputUrl(binding, verifier), expiresAt: new Date(expiresAt).toISOString(), receiptId: binding.id };
    });
    if (!result) publishedInputUnavailable();
    return Response.json(result, { status: 201, headers: { "cache-control": "private, no-store" } });
  } finally { if (selection) selection.body = {}; body = undefined; operation.stop("complete"); lease?.release(); }
}

// Invoke before correlation/access-log wrappers: the path contains a bearer
// verifier. No raw URL, credentials or caller-controlled error detail is emitted.
export async function servePublishedMusicInput(request: Request, env: Env): Promise<Response> {
  const operation = new HttpOperation(request.signal, 30_000);
  try {
    if (request.method !== "GET" || request.body || request.headers.has("range")
      || [...request.headers.keys()].some(key => key.startsWith("if-"))) publishedInputUnavailable();
    const receipt = await resolvePublishedInputUrl(env, request.url, operation.signal);
    return await publishedInputResponse(env, receipt, publishedMusicAccess(env, receipt.binding, operation));
  } catch {
    operation.stop("upstream");
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
}
