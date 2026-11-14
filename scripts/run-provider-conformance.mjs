import "../test/helpers/typescript-resolver.mjs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { PROVIDER_CONFORMANCE_EXECUTION_SCHEMA } from "../packages/provider-plugin-contract/src/index.ts";
import { loadProviderConformancePlan } from "./validate-provider-conformance.mjs";

const secret = "synthetic-conformance-key";
const routerSecret = "synthetic-conformance-router";
const maximumBodyBytes = 2 * 1024 * 1024;

function check(condition, message) {
  // Never include observed values: HTTP messages may contain credentials or content.
  if (!condition) throw new Error(`provider conformance execution: ${message}`);
}

async function checkMessage(actual, expected, label) {
  if (expected.status !== undefined) check(actual.status === expected.status, `${label} status mismatch`);
  for (const [name, value] of Object.entries(expected.headers ?? {})) {
    check(actual.headers.get(name) === value, `${label} header mismatch`);
  }
  const reader = actual.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBodyBytes) {
        await reader.cancel();
        check(false, `${label} body exceeds runner limit`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!Object.hasOwn(expected, "body")) check(text === "", `${label} unexpected body`);
  else {
    let body;
    try { body = JSON.parse(text); } catch { check(false, `${label} body is not JSON`); }
    check(isDeepStrictEqual(body, expected.body), `${label} body mismatch`);
  }
}

function preflight({ provider, scenario }) {
  const endpoint = provider.endpoints.find(row => row.id === scenario.endpoint);
  check(provider.class === "rest_json" && provider.adapter.request === "rest_json" && provider.adapter.response === "rest_json", "only REST JSON adapters are supported");
  check(provider.auth.schemes.length === 1 && provider.auth.schemes[0].type === "bearer"
    && provider.auth.schemes[0].secretKind === "api_key" && provider.auth.schemes[0].required
    && provider.auth.schemes[0].header.toLowerCase() === "authorization" && provider.auth.schemes[0].format === "Bearer ${secret}",
  "one required API-key bearer scheme is supported");
  check(!provider.auth.authorization && !provider.auth.refresh && !Object.keys(provider.auth.grantTransports).length,
    "subscription and OAuth execution are not supported");
  check(provider.config_keys.length === 1 && provider.config_keys[0].endsWith("_API_KEY"), "one API-key configuration value is supported");
  check(!provider.routing.baseUrlParam && !provider.routing.serviceParam
    && Object.keys(provider.base_urls).length === 1 && typeof provider.base_urls.default === "string"
    && !provider.base_urls.default.includes("${"), "one fixed upstream URL is supported");
  const base = new URL(provider.base_urls.default);
  check(base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash, "a fixed HTTPS upstream URL is required");
  check(scenario.model === undefined && provider.models.length === 0, "model-free exchanges are supported");
  check(endpoint.native_proxy && !endpoint.streaming && !endpoint.lifecycle, "one native non-streaming endpoint is required");
  check(endpoint.path_params.length === 0 && endpoint.path === new URL(`https://router.example${scenario.request.path}`).pathname
    && provider.endpoints.filter(row => row.path === endpoint.path).length === 1, "one unambiguous literal native route is required");
  check(provider.capabilities.filter(row => row.endpoint === endpoint.id && row.methods.includes("POST")).every(row => row.id === scenario.capability),
    "one unambiguous endpoint capability is required");
  check(!provider.adapter.stream && !provider.adapter.error, "stream and error adapters are not supported");
  for (const message of [scenario.request, scenario.upstream.response]) {
    const type = message.headers?.["content-type"];
    check(type === undefined || /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(type), "JSON content types are required");
  }
  check(scenario.request.method === "POST" && scenario.upstream.request.method === "POST", "POST JSON exchanges are supported");
  check(!scenario.request.headers?.authorization, "client authorization belongs to the host fixture");
  check(scenario.upstream.response.status !== 204 && scenario.upstream.response.status !== 205 && scenario.upstream.response.status !== 304
    || !Object.hasOwn(scenario.upstream.response, "body"), "bodyless HTTP statuses cannot contain a body");
}

async function environment(provider, sha256Hex) {
  const policy = { enabled: true, generation: "g1", providers: [provider.id], tenantId: "default", monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false };
  const credential = { enabled: true, secretSha256: await sha256Hex(routerSecret), policyId: "fixture", policyGeneration: "g1" };
  const connection = { providerId: provider.id, enabled: true, monthlyBudgetMicros: null };
  return {
    [provider.config_keys[0]]: secret,
    POLICY_KV: { get: async key => Array.isArray(key) ? new Map(key.map(item => [item, null])) : null },
    USAGE_QUEUE: { send: async () => {} },
    ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async url => {
      const path = new URL(url).pathname;
      if (path === "/admission/resolve") return Response.json({ credential: { credentialId: "fixture", credential }, policy: { policyId: "fixture", policy }, owner: null, connections: [connection], pools: { [provider.id]: { keys: [], states: {} } } });
      if (path === "/credentials/resolve") return Response.json({ initialized: true, credentials: [{ credentialId: "fixture", credential }], missingCredentialIds: [] });
      if (path === "/policies/resolve") return Response.json({ initialized: true, policies: [{ policyId: "fixture", policy }], missingPolicyIds: [] });
      if (path === "/connections/resolve") return Response.json({ initialized: true, connections: [connection], missingProviderIds: [] });
      if (path === "/grant-pools/resolve") return Response.json({ keys: [], states: {} });
      check(false, "unexpected authority operation");
    } }) },
  };
}

/**
 * Dedicated-process test harness. Never call concurrently or from the Worker.
 * @returns {Promise<import('../packages/provider-plugin-contract/src/index.ts').ProviderConformanceExecution>}
 */
export async function runProviderConformance(pluginPaths) {
  const plan = loadProviderConformancePlan(pluginPaths);
  plan.cases.forEach(preflight);
  const [{ default: worker }, { snapshot }, { sha256Hex }, { clearHotCaches }] = await Promise.all([
    import("../worker/index.ts"), import("../worker/providers.ts"), import("../worker/utils.ts"), import("../worker/hot-cache.ts"),
  ]);
  const originalFetch = globalThis.fetch;
  const original = { providers: snapshot.providers, model_index: snapshot.model_index };
  let active;
  try {
    snapshot.providers = plan.snapshot.providers;
    snapshot.model_index = plan.snapshot.model_index;
    for (const { provider, scenario } of plan.cases) {
      active = `${provider.id}/${scenario.id}`;
      clearHotCaches();
      const env = await environment(provider, sha256Hex), pending = [];
      let calls = 0, upstreamFailure;
      globalThis.fetch = async (input, init) => {
        try {
          check(++calls === 1, "unexpected extra upstream call");
          const request = new Request(input, init), url = new URL(request.url);
          check(url.origin === new URL(provider.base_urls.default).origin, "upstream origin mismatch");
          check(url.pathname + url.search === scenario.upstream.request.path, "upstream path mismatch");
          check(request.method === scenario.upstream.request.method, "upstream method mismatch");
          check(request.redirect === "manual", "upstream redirects must remain disabled");
          check(request.headers.get("authorization") === `Bearer ${secret}`, "synthetic upstream authorization mismatch");
          await checkMessage(request, scenario.upstream.request, "upstream request");
          const response = scenario.upstream.response;
          return new Response(Object.hasOwn(response, "body") ? JSON.stringify(response.body) : null, {
            status: response.status, headers: { "content-type": "application/json", ...response.headers },
          });
        } catch (error) { upstreamFailure ??= error; throw error; }
      };
      let response;
      try {
        const request = scenario.request;
        const path = `/v1/native/${provider.id}${request.path}`;
        response = await worker.fetch(new Request(`https://router.example${path}`, {
          method: request.method,
          headers: { "content-type": "application/json", ...request.headers, authorization: `Bearer clawrouter-live-fixture-${routerSecret}` },
          ...(Object.hasOwn(request, "body") ? { body: JSON.stringify(request.body) } : {}),
        }), env, { waitUntil: promise => { pending.push(promise); } });
        if (upstreamFailure) throw upstreamFailure;
        check(calls === 1, "expected exactly one upstream call");
        await checkMessage(response, scenario.response, "client response");
      } finally {
        // Retire the response before joining host settlement, including mismatch paths.
        if (response?.body && !response.body.locked && !response.bodyUsed) await response.body.cancel();
        while (pending.length) {
          const results = await Promise.allSettled(pending.splice(0));
          check(results.every(result => result.status === "fulfilled"), "host settlement failed");
        }
      }
    }
    return { schema: PROVIDER_CONFORMANCE_EXECUTION_SCHEMA, scope: "native-rest-json-exchanges", packages: plan.report.packages };
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith("provider conformance execution:")
      ? error.message.slice("provider conformance execution:".length).trim() : "host failure";
    throw new Error(`provider conformance execution: ${active}: ${detail}`);
  } finally {
    globalThis.fetch = originalFetch;
    snapshot.providers = original.providers;
    snapshot.model_index = original.model_index;
    clearHotCaches();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), paths = [];
    for (let i = 0; i < args.length; i += 2) {
      check(args[i] === "--plugin" && args[i + 1] && !args[i + 1].startsWith("--"), "usage: run-provider-conformance --plugin descriptor [--plugin descriptor...]");
      paths.push(args[i + 1]);
    }
    process.stdout.write(`${JSON.stringify(await runProviderConformance(paths), null, 2)}\n`);
  } catch (error) {
    // Loader/compiler diagnostics are useful locally but may include authored data.
    process.stderr.write(`${error.message.startsWith("provider conformance execution:") ? error.message : "provider conformance execution: invalid package or host failure"}\n`);
    process.exitCode = 1;
  }
}
