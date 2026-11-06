import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
import { byteBody, syntheticTransport } from "./minimax-search-byte-fixture.mjs";
import { configureVideo, videoInput, submitted, completed, metadata, mp4 } from "./minimax-video-declaration-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const { miniMaxVideoBinding } = await import("../../shared/minimax-video-binding.ts");
export { grantKey, videoInput, submitted, completed, metadata, mp4 };
export const actor = { auth: "cloudflare_access", email: "admin@example.invalid", role: "admin" };
export const native = "/v1/native/minimax/v1/video_generation", poll = "/v1/native/minimax/v1/query/video_generation?task_id=" + submitted.task_id;
export async function setup(t, options = {}) {
  const f = await fixture(t, { providerId: "minimax", fixed: options.fixed === undefined ? 700 : options.fixed, configure: configureVideo });
  for (const name of ["ACCESS_CONTROL", "BUDGET_LEDGER", "GRANT_CREDENTIALS", "USAGE_LEDGER"]) {
    const namespace = f.env[name], get = namespace.get.bind(namespace);
    namespace.get = id => { const stub = get(id); return { async fetch(...args) { return syntheticTransport(await stub.fetch(...args)); } }; };
  }
  const upstream = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args) => syntheticTransport(await upstream(args[0], args[1]?.body instanceof ReadableStream ? { ...args[1], duplex: "half" } : args[1])));
  f.env.MINIMAX_API_KEY = "synthetic-forbidden-environment-key";
  f.user = (enabled = true, role = "admin") => f.authority("/users/put", { email: actor.email,
    record: { role, enabled, tenantId: "tenant", groups: [], contentRetentionDisabled: false } });
  await f.user();
  f.put = (body, intent, replace = false) => putGrantCredentials(f.env, grantKey, body, !replace, replace ? "replace" : undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, intent, actor);
  if (!options.environment) await f.put({ provider: "minimax", kind: "api_key", enabled: true, credential: "synthetic-video-key", accountId: "synthetic-account" },
    options.qualify === false ? undefined : miniMaxVideoBinding(options.region ?? "global"));
  f.policy.grantRouting = { eligibleGrants: options.environment ? {} : { minimax: ["replicate"] }, environmentFallback: true, failover: true };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const pending = [], drain = f.drain;
  f.drain = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); await drain(); };
  f.invoke = (target, body, extra = {}) => worker.fetch(new Request("https://router.example" + target, {
    method: body == null ? "GET" : "POST", ...extra, duplex: "half",
    headers: { authorization: "Bearer clawrouter-live-fixture-fixture-secret", "content-type": "application/json", ...extra.headers },
    ...(body == null ? {} : { body: byteBody(typeof body === "string" ? body : JSON.stringify(body)) }) }), f.env, { waitUntil: p => pending.push(p) });
  f.create = (manifest = false, model, extra = {}) => f.invoke(manifest ? "/v1/proxy/minimax/video" : native,
    manifest ? { body: { ...videoInput(model), model: "minimax/" + (model ?? videoInput().model) } } : videoInput(model), extra);
  f.upstream = request => request.method === "POST" ? Response.json(submitted)
    : request.url.includes("retrieve_content") ? new Response(mp4(), { headers: { "content-type": "application/json" } })
    : request.url.includes("/files/retrieve") ? Response.json(metadata) : Response.json(completed);
  f.materializations = 0;
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(url, init) {
    if (new URL(url).pathname === "/materialize") f.materializations++;
    return stub.fetch(url, init);
  } }; };
  f.record = () => f.env.GRANT_CREDENTIALS.objects.get(grantKey).values.get("credential");
  t.after(f.drain); return f;
}
