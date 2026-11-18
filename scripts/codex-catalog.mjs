import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodexCatalog } from "../shared/codex-catalog.ts";
export { buildCodexCatalog } from "../shared/codex-catalog.ts";

export async function readCodexCatalog({ routerUrl, providerId, codex = "codex", env = process.env, headers = {}, catalogMode = "local", webSearch = "disabled" }) {
  if (!["local", "remote"].includes(catalogMode) || catalogMode === "remote" && providerId !== "openai") throw new Error("remote Codex metadata currently supports only the openai provider");
  let origin;
  try { origin = new URL(routerUrl); } catch { throw new Error("router URL is invalid"); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("router URL must be the router origin without credentials, path, or query");
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("router URL must use HTTPS (except loopback fixtures)");
  const key = env.CLAWROUTER_API_KEY;
  if (!key?.trim()) throw new Error("CLAWROUTER_API_KEY is required");
  let routerBytes;
  try {
    const response = await fetch(new URL("/v1/catalog", origin), { headers: { ...headers, authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
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
    version = execFileSync(codex, ["--version"], options).trim();
    if (!/^codex-cli [\w.+-]+$/.test(version)) throw new Error("invalid producer version");
    if (catalogMode === "local") bundledBytes = execFileSync(codex, ["debug", "models", "--bundled"], options);
  } catch { throw new Error("native Codex bundled export failed; check --codex and producer version"); }
  let catalogUrl;
  if (catalogMode === "remote") {
    const release = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
    if (!release || Number(release[1]) === 0 && Number(release[2]) < 169) throw new Error("remote catalog setup requires Codex CLI 0.169.0 or newer");
    catalogUrl = new URL("/v1/codex/models", origin);
    if (webSearch !== "disabled") catalogUrl.searchParams.set("standalone_search", "true");
    const fetchUrl = new URL(catalogUrl);
    fetchUrl.searchParams.set("client_version", release.slice(1, 4).join("."));
    try {
      const response = await fetch(fetchUrl, { headers: { ...headers, authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { void response.body?.cancel(); throw new Error("remote catalog rejected"); }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error("remote catalog too large");
        chunks.push(chunk);
      }
      bundledBytes = Buffer.concat(chunks).toString("utf8");
    } catch { throw new Error("authorized remote Codex catalog request failed; no files changed"); }
  }
  let router, bundled;
  try { router = JSON.parse(routerBytes); bundled = JSON.parse(bundledBytes); }
  catch { throw new Error("router catalog or native export is invalid JSON"); }
  // Remote descriptors already use inference slugs. An alias-only policy may
  // omit its source descriptor; do not try to apply codexModel a second time.
  const projection = catalogMode === "remote" ? { ...router, providers: router.providers.map(provider => provider.id === providerId
    ? { ...provider, models: provider.models.map(model => ({ ...model, codexModel: model.upstream })) } : provider) } : router;
  const result = buildCodexCatalog(projection, bundled, providerId);
  const baseUrl = new URL(result.nativeBasePath, origin);
  if (baseUrl.origin !== origin.origin) throw new Error("native route must stay on the router origin");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  return { ...result, routerUrl: origin.origin, baseUrl: baseUrl.href,
    ...(catalogUrl ? { catalogMode, catalogUrl: catalogUrl.href } : {}),
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
