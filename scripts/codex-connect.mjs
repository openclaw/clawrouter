import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { readCodexCatalog } from "./codex-catalog.mjs";

const MARKER = "# clawrouter-connect-v1 ";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = (path) => JSON.stringify(path);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const providerId = (profile) => `clawrouter_${profile}`;
const catalogName = (profile, digest) => `${profile}.${digest}.models.json`;
const rootFields = ["model", "model_provider", "model_catalog_json", "service_tier", "web_search"];
const providerFields = ["name", "base_url", "wire_api", "env_key", "requires_openai_auth", "supports_websockets"];

function document(text) {
  let ast;
  try { ast = parseTOML(text, { tomlVersion: "1.0.0" }); }
  catch { throw new Error("configuration is not valid TOML; no files changed"); }
  const fields = new Map();
  for (const node of ast.body[0].body) {
    const prefix = node.type === "TOMLTable" ? node.resolvedKey : [];
    for (const field of node.type === "TOMLTable" ? node.body : [node]) {
      const path = [...prefix, ...getStaticTOMLValue(field.key)];
      fields.set(key(path), { node: field, path });
    }
  }
  return { fields, tables: ast.body[0].body.filter((node) => node.type === "TOMLTable").map((node) => node.resolvedKey) };
}

function fieldsFor(profile, options, catalog) {
  return [
    [["model"], options.model], [["model_provider"], providerId(profile)],
    [["model_catalog_json"], catalogName(profile, hash(`${JSON.stringify(catalog.catalog)}\n`))],
    [["service_tier"], options.serviceTier], [["web_search"], "disabled"],
    ...Object.entries({ name: "ClawRouter", base_url: catalog.baseUrl, wire_api: "responses",
      env_key: "CLAWROUTER_API_KEY", requires_openai_auth: false,
      supports_websockets: catalog.supportsWebsockets })
      .map(([name, value]) => [["model_providers", providerId(profile), name], value]),
  ];
}

function render(fields) {
  const root = fields.filter(([path]) => path.length === 1);
  const provider = fields.filter(([path]) => path.length === 3);
  const entry = ([path, value]) => `${JSON.stringify(path.at(-1))} = ${JSON.stringify(value)}\n`;
  return `${root.map(entry).join("")}\n[model_providers.${JSON.stringify(provider[0][0][1])}]\n${provider.map(entry).join("")}`;
}

// Edit value ranges, never reserialize the user's document. Removal only owns
// unchanged scalar fields; a user rewrite into an inline table is retained.
function patch(text, previous, next) {
  const { fields } = document(text), edits = [], retained = [];
  for (const [path, value] of previous) {
    const field = fields.get(key(path));
    if (!field || field.node.value.type !== "TOMLValue" || getStaticTOMLValue(field.node.value) !== value) {
      retained.push(path.join("."));
      continue;
    }
    const replacement = next?.find(([candidate]) => key(candidate) === key(path));
    const range = replacement ? field.node.value.range : field.node.range;
    edits.push([range[0], range[1], replacement ? JSON.stringify(replacement[1]) : ""]);
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  document(text);
  return { text, retained };
}

async function readRegular(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error("setup paths must be regular files, not symlinks");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code) throw new Error("could not read setup files");
    throw error;
  }
}

async function replace(path, bytes, expected) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (await readRegular(path) !== expected) throw new Error("setup file changed during the operation; retry after reviewing it");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function receipt(text, profile) {
  if (!text?.startsWith(MARKER)) throw new Error("profile is not owned by this setup; choose another --profile");
  let state;
  try { state = JSON.parse(text.slice(MARKER.length, text.indexOf("\n"))); }
  catch { throw new Error("profile ownership receipt is invalid"); }
  const allowed = new Set([
    ...rootFields.map((name) => key([name])),
    ...providerFields.map((name) => key(["model_providers", providerId(profile), name])),
  ]);
  if (state.version !== 1 || state.profile !== profile || typeof state.routerUrl !== "string" || typeof state.provider !== "string" || typeof state.model !== "string" || !["default", "priority"].includes(state.serviceTier)
    || !/^[a-f0-9]{64}$/.test(state.catalogSha256) || !Array.isArray(state.fields)
    || !Array.isArray(state.catalogs) || !state.catalogs.includes(state.catalogSha256)
    || state.catalogs.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
    || state.fields.length !== allowed.size || state.fields.some((field) => !Array.isArray(field) || field.length !== 2 || !Array.isArray(field[0]))
    || new Set(state.fields.map(([path]) => key(path))).size !== allowed.size
    || state.fields.some(([path, value]) => !allowed.has(key(path)) || !["string", "boolean"].includes(typeof value))) {
    throw new Error("profile ownership receipt is invalid");
  }
  if (state.fields.find(([path]) => path[0] === "model_catalog_json")?.[1] !== catalogName(profile, state.catalogSha256)) throw new Error("profile catalog receipt is invalid");
  return state;
}

function baseCompatible(text, profile) {
  const { fields, tables } = document(text ?? "");
  for (const { path, node } of [...fields.values(), ...tables.map((path) => ({ path }))]) {
    const target = path[0] === "model_providers" ? providerId(profile) : path[0] === "profiles" ? profile : null;
    const inlineCollision = target && path.length === 1 && node?.value.type === "TOMLInlineTable" && Object.hasOwn(getStaticTOMLValue(node.value), target);
    if (path[0] === "profile" || (target && path[1] === target) || inlineCollision) {
      throw new Error("base config has a conflicting provider or legacy profile; choose another profile or resolve it manually");
    }
  }
}

function parse(args, env) {
  const [command, ...rest] = args;
  if (!["connect", "verify", "update", "remove"].includes(command)) throw new Error("choose connect, verify, update, or remove; use --help");
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (name === "--dry-run") { options.dryRun = true; continue; }
    if (!["--router-url", "--provider", "--model", "--service-tier", "--profile", "--codex-home", "--codex", "--key-file"].includes(name)
      || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error("invalid arguments; use --help");
    if (Object.hasOwn(options, name)) throw new Error("duplicate argument; use --help");
    options[name] = rest[++index];
  }
  const profile = options["--profile"] ?? "clawrouter";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile) || profile === "config") throw new Error("profile must be 1–64 letters, digits, underscores, or hyphens, excluding config");
  if (command !== "connect" && ["--router-url", "--provider", "--model", "--service-tier"].some((name) => options[name])) throw new Error("connection settings belong to connect; remove and reconnect to change them");
  return { command, profile, home: resolve(options["--codex-home"] ?? env.CODEX_HOME ?? join(homedir(), ".codex")),
    routerUrl: options["--router-url"], provider: options["--provider"], model: options["--model"],
    serviceTier: options["--service-tier"] ?? "default", codex: options["--codex"],
    keyFile: options["--key-file"], dryRun: options.dryRun === true };
}

export async function manageCodex(args, env = process.env) {
  const options = parse(args, env);
  const { command, profile, home, dryRun } = options;
  const path = join(home, `${profile}.config.toml`);
  if (command === "connect" && (!options.routerUrl || !options.provider || !options.model || !["default", "priority"].includes(options.serviceTier))) throw new Error("connect requires --router-url, --provider, --model, and a valid --service-tier (default or priority)");
  const original = await readRegular(path);
  if (command === "connect" && original !== null) throw new Error("profile already exists; use update or choose another --profile");
  if (command === "remove" && original === null) return { command, profile, status: "absent", revoked: false };
  const state = command === "connect" ? null : receipt(original, profile);
  const oldCatalog = state && join(home, catalogName(profile, state.catalogSha256));
  const oldBytes = oldCatalog && await readRegular(oldCatalog);
  let text, nextBytes, nextCatalog, nextState, retained = [];
  if (command === "remove") {
    const patched = patch(original.slice(original.indexOf("\n") + 1), state.fields);
    text = patched.text;
    retained = patched.retained;
  } else {
    baseCompatible(await readRegular(join(home, "config.toml")), profile);
    if (state && patch(original.slice(original.indexOf("\n") + 1), state.fields, state.fields).retained.length) throw new Error("owned profile settings changed; review them before remove/reconnect");
    if (state && (!oldBytes || hash(oldBytes) !== state.catalogSha256)) throw new Error("owned model catalog changed or is missing; no files changed");
    let keyValue = env.CLAWROUTER_API_KEY;
    if (options.keyFile) {
      try { keyValue = (await readFile(options.keyFile, "utf8")).trim(); }
      catch { throw new Error("could not read --key-file"); }
    }
    const settings = state ?? options;
    const catalog = await readCodexCatalog({ routerUrl: settings.routerUrl, providerId: settings.provider, codex: options.codex,
      env: { ...env, CLAWROUTER_API_KEY: keyValue } });
    const selected = catalog.catalog.models.find((model) => model.slug === settings.model);
    if (!selected) throw new Error("selected model has no authorized native descriptor");
    if (settings.serviceTier === "priority" && !selected.service_tiers?.some((tier) => tier.id === "priority")) throw new Error("selected model does not advertise a qualified priority tier");
    nextBytes = `${JSON.stringify(catalog.catalog)}\n`;
    const fields = fieldsFor(profile, settings, catalog);
    nextState = { version: 1, profile, routerUrl: catalog.routerUrl, provider: settings.provider, model: settings.model,
      serviceTier: settings.serviceTier, catalogSha256: hash(nextBytes),
      catalogs: [...new Set([...(state?.catalogs ?? []), hash(nextBytes)])].sort(), fields };
    const body = state ? patch(original.slice(original.indexOf("\n") + 1), state.fields, fields).text : render(fields);
    text = `${MARKER}${JSON.stringify(nextState)}\n${body}`;
    document(text);
    nextCatalog = join(home, catalogName(profile, nextState.catalogSha256));
    if (command === "verify") {
      if (nextState.catalogSha256 !== state.catalogSha256 || JSON.stringify(fields) !== JSON.stringify(state.fields)) throw new Error("authorized catalog or transport changed; run update then restart Codex");
      return { command, profile, status: "verified", inferenceProbed: false, producer: catalog.producer };
    }
  }
  const changed = command === "remove" ? state.fields.map(([path]) => path.join(".")).filter((field) => !retained.includes(field))
    : nextState.fields.filter(([path, value]) => !state?.fields.some(([oldPath, oldValue]) => key(path) === key(oldPath) && value === oldValue)).map(([path]) => path.join("."));
  const summary = { command, profile, status: dryRun ? "planned" : "applied", changed, retained,
    ...(command === "remove" ? { revoked: false } : { catalogSha256: nextState.catalogSha256, restartRequired: true, launch: `CODEX_HOME=${shellQuote(home)} codex --profile ${profile}`, credential: "CLAWROUTER_API_KEY must be exported in the Codex process environment" }) };
  if (dryRun) return summary;

  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, `.${profile}.clawrouter-connect.lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("another setup operation owns the profile lock; if interrupted, inspect it before removing the lock directory"); }
  let createdCatalog = false, committed = false;
  try {
    if (await readRegular(path) !== original) throw new Error("profile changed during the operation; no files changed");
    if (command !== "remove") baseCompatible(await readRegular(join(home, "config.toml")), profile);
    if (nextCatalog) {
      const existing = await readRegular(nextCatalog);
      if (existing !== null && existing !== nextBytes) throw new Error("catalog generation already exists with different content");
      if (existing === null) {
        await replace(nextCatalog, nextBytes, null);
        createdCatalog = true;
      }
    }
    // The catalog is complete before one atomic profile rename commits both
    // its pointer and ownership receipt. Failed refreshes keep the old profile.
    await replace(path, text, original);
    committed = true;
    // Codex reads the profile and catalog separately. Keep every published
    // generation until explicit disconnect so concurrent startup stays valid.
    if (command === "remove") {
      // A user can roll the pointer back to a published generation. Once that
      // field is user-owned, retain all generations instead of breaking it.
      const keepCatalogs = retained.includes("model_catalog_json");
      if (keepCatalogs) summary.retained.push("model catalogs retained because the catalog pointer changed");
      for (const digest of keepCatalogs ? [] : state.catalogs) {
        const name = catalogName(profile, digest);
        try {
          const current = await readRegular(join(home, name));
          if (current !== null && hash(current) === digest) await rm(join(home, name));
          else if (current !== null) summary.retained.push(`${name}: modified outside setup`);
        } catch { summary.retained.push(`${name}: could not be removed`); }
      }
      if (text.replace(/\s/g, "") === `[model_providers.${JSON.stringify(providerId(profile))}]`) {
        if (await readRegular(path) === text) await rm(path);
        else summary.retained.push("profile changed during removal");
      }
    }
  } finally {
    // Only this attempt's unreferenced generation is disposable on failure.
    // A concurrently edited profile may already point at it.
    try {
      if (createdCatalog && !committed && !(await readRegular(path))?.includes(catalogName(profile, nextState.catalogSha256))
        && await readRegular(nextCatalog) === nextBytes) await rm(nextCatalog);
    } finally { await rm(lock, { recursive: true }); }
  }
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node scripts/codex-connect.mjs <connect|verify|update|remove> [--profile clawrouter] [--codex-home DIR] [--codex PATH] [--key-file PATH] [--dry-run]\nconnect requires --router-url ORIGIN --provider ID --model UPSTREAM_SLUG [--service-tier default|priority].\nUses CLAWROUTER_API_KEY unless --key-file supplies it for this command. No key is stored. Start Codex with the environment key exported.\nCreates a separate CLI profile; root config, auth, sandbox, shell startup, and key files are untouched. Verify makes no inference calls. Remove does not revoke a key.\n");
  } else {
    manageCodex(process.argv.slice(2)).then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`)).catch((error) => {
      process.stderr.write(`Codex setup failed: ${error.code ? "filesystem operation failed" : error.message}\n`);
      process.exitCode = 1;
    });
  }
}
