import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Native export owns prompts, tool contracts, and internal model references.
// The router only chooses reachable slugs and narrows advertised paid tiers.
export function buildCodexCatalog(catalog, bundled, providerId) {
  const provider = catalog.providers?.find((item) => item.id === providerId && item.allowed && item.executable);
  if (!provider) throw new Error("selected provider is not authorized and executable");
  const responses = provider.routes?.filter((route) => route.methods?.includes("POST") && route.requestFormat === "openai.responses" && route.responseFormat === "openai.responses" && route.streaming === "sse");
  if (responses?.length !== 1 || !responses[0].path.endsWith("/responses")) throw new Error("selected provider needs one executable native Responses route");
  if (!Array.isArray(bundled.models) || !bundled.models.length) throw new Error("native Codex export contains no models");
  const official = new Map(bundled.models.map((model) => [model.slug, model]));
  const models = [], skipped = [], mappings = [], slugs = new Set();
  for (const model of provider.models ?? []) {
    if (!model.capabilities?.includes("llm.responses")) continue;
    const upstream = model.upstream;
    const descriptor = official.get(model.codexModel ?? upstream);
    if (typeof upstream !== "string" || !upstream || upstream.includes("${") || !descriptor) {
      skipped.push({ model: model.id, reason: "no exact native Codex descriptor" });
      continue;
    }
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
  return { catalog: { models }, skipped, mappings, nativeBasePath: `${provider.nativeBaseUrl}${responses[0].path.slice(0, -"/responses".length)}` };
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
  const origin = new URL(options["--router-url"]);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("--router-url must be the router origin without credentials, path, or query");
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("router URL must use HTTPS (except loopback fixtures)");
  const key = process.env.CLAWROUTER_API_KEY;
  if (!key) throw new Error("CLAWROUTER_API_KEY is required");
  const response = await fetch(new URL("/v1/catalog", origin), { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`authorized router catalog returned HTTP ${response.status}`);
  const routerBytes = await response.text();
  const codex = options["--codex"] ?? "codex";
  const nativeEnv = { ...process.env, CLAWROUTER_API_KEY: undefined };
  const bundledBytes = execFileSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", env: nativeEnv, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  const version = execFileSync(codex, ["--version"], { encoding: "utf8", env: nativeEnv, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const result = buildCodexCatalog(JSON.parse(routerBytes), JSON.parse(bundledBytes), options["--provider"]);
  const output = resolve(options["--output"]), temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(result.catalog)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  process.stderr.write(`${JSON.stringify({ producer: version, bundledSha256: hash(bundledBytes), routerCatalogSha256: hash(routerBytes), baseUrl: new URL(result.nativeBasePath, origin).href, mappings: result.mappings, skipped: result.skipped })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`codex catalog export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
