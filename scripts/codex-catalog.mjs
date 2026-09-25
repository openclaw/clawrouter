import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Native export owns prompts, tool contracts, and internal model references.
// The router only chooses reachable slugs and narrows advertised paid tiers.
export function buildCodexCatalog(catalog, bundled, providerId) {
  if (catalog.version !== "clawrouter.client-catalog.v1" || catalog.scope?.authType !== "proxy_key" || typeof catalog.scope.credentialId !== "string" || !catalog.scope.credentialId) throw new Error("Codex setup needs a key-scoped operation catalog; update the router and fetch with the issued key");
  const provider = catalog.providers?.find((item) => item.id === providerId && item.allowed === true);
  if (!provider) throw new Error("selected provider is not authorized");
  if (!Array.isArray(provider.offers)) throw new Error("router catalog lacks operation offers; update the router before Codex setup");
  if (provider.nativeBaseUrl !== `/v1/native/${providerId}` || !Array.isArray(provider.policies) || provider.policies.length !== 1 || typeof provider.policies[0] !== "string" || !provider.policies[0]) throw new Error("selected provider needs one key-scoped native policy");
  const offers = provider.offers.filter((offer) => offer.eligible === true && offer.routeKind === "native" && offer.policyId === provider.policies[0] && typeof offer.policyGeneration === "string" && offer.policyGeneration && ["exact-covered", "request-dependent"].includes(offer.affordability));
  const matching = (model, route, transport) => offers.filter((offer) => typeof model.id === "string" && model.id && offer.modelId === model.id && offer.endpoint === route.endpoint && offer.route === `${provider.nativeBaseUrl}${route.path}` && offer.transport === transport);
  const responses = provider.routes?.filter((route) => typeof route.endpoint === "string" && route.endpoint && typeof route.path === "string" && route.path.endsWith("/responses") && route.methods?.includes("POST") && route.requestFormat === "openai.responses" && route.responseFormat === "openai.responses" && route.streaming === "sse" && provider.models?.some((model) => model.capabilities?.includes("llm.responses") && matching(model, route, "http").length));
  if (responses?.length !== 1) throw new Error("selected provider needs one eligible native HTTP Responses route");
  const responseRoute = responses[0];
  if (!Array.isArray(bundled.models) || !bundled.models.length) throw new Error("native Codex export contains no models");
  const official = new Map(bundled.models.map((model) => [model.slug, model]));
  const models = [], skipped = [], mappings = [], slugs = new Set();
  let generation, supportsWebsockets = responseRoute.websocket === "openai.responses";
  for (const model of provider.models ?? []) {
    if (!model.capabilities?.includes("llm.responses")) continue;
    const http = matching(model, responseRoute, "http");
    if (!http.length) {
      skipped.push({ model: model.id, reason: "no eligible native HTTP Responses offer" });
      continue;
    }
    const upstream = model.upstream;
    const descriptor = official.get(model.codexModel ?? upstream);
    if (typeof upstream !== "string" || !upstream || upstream.includes("${") || !descriptor) {
      skipped.push({ model: model.id, reason: "no exact native Codex descriptor" });
      continue;
    }
    generation ??= http[0].policyGeneration;
    if (http.some((offer) => offer.policyGeneration !== generation)) throw new Error("native Responses offers disagree on the key policy generation; fetch a fresh catalog");
    // Codex enables WS for the entire provider/session, including internal
    // models. One route-wide or main-model offer cannot qualify that flag.
    supportsWebsockets &&= matching(model, responseRoute, "websocket").some((offer) => offer.policyGeneration === generation);
    if (!descriptor.model_messages?.instructions_template && !descriptor.base_instructions) throw new Error(`native descriptor for ${model.id} has no instructions`);
    if (slugs.has(upstream)) throw new Error(`duplicate native model route: ${upstream}`);
    slugs.add(upstream);
    const copy = structuredClone(descriptor);
    copy.slug = upstream;
    const context = descriptor.max_context_window ?? descriptor.context_window;
    const cards = (model.pricing?.serviceTiers ?? []).filter((card) => card.maxInputTokens == null || (typeof context === "number" && card.maxInputTokens >= context));
    const tiers = new Set(cards.flatMap((card) => [card.id, ...(card.aliases ?? [])]));
    copy.service_tiers = (copy.service_tiers ?? []).filter((tier) => tiers.has(tier.id));
    const advertised = new Set(copy.service_tiers.map((tier) => tier.id));
    copy.additional_speed_tiers = (copy.additional_speed_tiers ?? []).filter((tier) => advertised.has(tier === "fast" ? "priority" : tier));
    if (copy.default_service_tier != null && !advertised.has(copy.default_service_tier)) copy.default_service_tier = null;
    models.push(copy);
    mappings.push({ route: model.id, upstream, descriptor: descriptor.slug });
  }
  if (!models.length) throw new Error("no authorized Responses model has exact native Codex metadata");
  return { catalog: { models }, skipped, mappings, supportsWebsockets, nativeBasePath: `${provider.nativeBaseUrl}${responseRoute.path.slice(0, -"/responses".length)}` };
}

export async function readCodexCatalog({ routerUrl, providerId, codex = "codex", env = process.env }) {
  let origin;
  try { origin = new URL(routerUrl); } catch { throw new Error("router URL is invalid"); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("router URL must be the router origin without credentials, path, or query");
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("router URL must use HTTPS (except loopback fixtures)");
  const key = env.CLAWROUTER_API_KEY;
  if (!key?.trim()) throw new Error("CLAWROUTER_API_KEY is required");
  let routerBytes;
  try {
    const response = await fetch(new URL("/v1/catalog", origin), { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`authorized router catalog returned HTTP ${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("authorized router catalog exceeds 16 MiB");
      chunks.push(chunk);
    }
    routerBytes = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error.message.startsWith("authorized router catalog ")) throw error;
    throw new Error("authorized router catalog request failed");
  }
  let bundledBytes, version;
  try {
    const nativeEnv = { ...env, CLAWROUTER_API_KEY: undefined };
    const options = { encoding: "utf8", env: nativeEnv, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] };
    bundledBytes = execFileSync(codex, ["debug", "models", "--bundled"], options);
    version = execFileSync(codex, ["--version"], options).trim();
    if (!/^codex-cli [\w.+-]+$/.test(version)) throw new Error("invalid producer version");
  } catch { throw new Error("native Codex bundled export failed; check --codex and producer version"); }
  let router, bundled;
  try { router = JSON.parse(routerBytes); bundled = JSON.parse(bundledBytes); }
  catch { throw new Error("router catalog or native export is invalid JSON"); }
  const result = buildCodexCatalog(router, bundled, providerId);
  const baseUrl = new URL(result.nativeBasePath, origin);
  if (baseUrl.origin !== origin.origin) throw new Error("native route must stay on the router origin");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  return { ...result, routerUrl: origin.origin, baseUrl: baseUrl.href,
    producer: version, bundledSha256: hash(bundledBytes), routerCatalogSha256: hash(routerBytes) };
}

async function main(args) {
  if (args.includes("--help")) {
    process.stdout.write("Usage: node scripts/codex-catalog.mjs --router-url https://router.example --provider openai --output ./clawrouter-models.json [--codex /path/to/codex]\nAuthentication: CLAWROUTER_API_KEY. Reads only the authorized catalog and native bundled model metadata.\n");
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--router-url", "--provider", "--output", "--codex"].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("invalid arguments; use --help");
    options[args[index]] = args[index + 1];
  }
  if (!options["--router-url"] || !options["--provider"] || !options["--output"]) throw new Error("--router-url, --provider, and --output are required");
  const result = await readCodexCatalog({ routerUrl: options["--router-url"], providerId: options["--provider"], codex: options["--codex"] });
  const output = resolve(options["--output"]), temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(result.catalog)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  const { catalog, nativeBasePath, ...summary } = result;
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`codex catalog export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
