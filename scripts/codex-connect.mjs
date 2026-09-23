import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { readCodexCatalog } from "./codex-catalog.mjs";

const MARKER = "# clawrouter-connect-v1 ";
const DESKTOP_MARKER = "# clawrouter-desktop-v1 ";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = (path) => JSON.stringify(path);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const providerId = (profile) => profile === null ? "clawrouter.desktop" : `clawrouter_${profile}`;
const catalogName = (profile, digest) => `${profile ?? ".clawrouter-desktop"}.${digest}.models.json`;
const marker = (profile) => profile === null ? DESKTOP_MARKER : MARKER;
const rootFields = ["model", "model_provider", "model_catalog_json", "service_tier", "web_search"];
const providerFields = ["name", "base_url", "wire_api", "env_key", "requires_openai_auth", "supports_websockets"];

function document(text) {
  let ast;
  try { ast = parseTOML(text, { tomlVersion: "1.0.0" }); }
  catch { throw new Error("configuration is not valid TOML; no files changed"); }
  const fields = new Map();
  const visit = (field, prefix) => {
    const path = [...prefix, ...getStaticTOMLValue(field.key)];
    fields.set(key(path), { node: field, path });
    if (field.value.type === "TOMLInlineTable") for (const member of field.value.body) visit(member, path);
  };
  for (const node of ast.body[0].body) {
    const prefix = node.type === "TOMLTable" ? node.resolvedKey : [];
    for (const field of node.type === "TOMLTable" ? node.body : [node]) visit(field, prefix);
  }
  return { fields, tables: ast.body[0].body.filter((node) => node.type === "TOMLTable") };
}

function fieldsFor(profile, options, catalog) {
  return [
    [["model"], options.model], [["model_provider"], providerId(profile)],
    [["model_catalog_json"], catalogName(profile, hash(`${JSON.stringify(catalog.catalog)}\n`))],
    ...(profile === null ? [] : [[["service_tier"], options.serviceTier]]), [["web_search"], "disabled"],
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
function patch(text, previous, next, raw = false) {
  const { fields } = document(text), edits = [], retained = [];
  for (const [path, value] of previous) {
    const field = fields.get(key(path));
    if (!field || field.node.value.type !== "TOMLValue" || getStaticTOMLValue(field.node.value) !== value) {
      retained.push(path.join("."));
      continue;
    }
    const replacement = next?.find(([candidate]) => key(candidate) === key(path));
    const range = replacement ? field.node.value.range : field.node.range;
    edits.push([range[0], range[1], replacement ? raw ? replacement[1] : JSON.stringify(replacement[1]) : ""]);
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  document(text);
  return { text, retained };
}

function installDesktop(text, fields) {
  const parsed = document(text), originals = [], previous = [], missing = [];
  for (const [path, value] of fields.filter(([path]) => path.length === 1)) {
    const field = parsed.fields.get(key(path));
    if (field && (field.node.value.type !== "TOMLValue" || typeof getStaticTOMLValue(field.node.value) !== "string")) throw new Error("Desktop routing settings must be scalar strings; no files changed");
    originals.push([path, field ? text.slice(...field.node.value.range) : null]);
    if (field) previous.push([path, getStaticTOMLValue(field.node.value)]);
    else missing.push(`${JSON.stringify(path[0])} = ${JSON.stringify(value)}\n`);
  }
  let body = patch(text, previous, fields).text;
  const provider = fields.filter(([path]) => path.length > 1);
  const inline = document(body).fields.get(key(["model_providers"]))?.node.value;
  if (inline?.type === "TOMLInlineTable") {
    const at = inline.body.at(-1)?.range[1] ?? inline.range[0] + 1;
    const member = `${inline.body.length ? ", " : ""}${JSON.stringify(providerId(null))} = { ${provider.map(([path, value]) => `${JSON.stringify(path[2])} = ${JSON.stringify(value)}`).join(", ")} }`;
    body = body.slice(0, at) + member + body.slice(at);
  } else body += render(provider);
  body = missing.join("") + body;
  document(body);
  return { body, originals };
}

function removeOwned(text, state) {
  const inProvider = (path) => path[0] === "model_providers" && path[1] === providerId(state.profile);
  const before = document(text), member = before.fields.get(key(["model_providers", providerId(state.profile)]));
  const inlineFields = [...before.fields.values()].filter(({ path, node }) => inProvider(path) && path.length === 3 && node.parent.type === "TOMLInlineTable");
  if (member?.node.value.type === "TOMLInlineTable" || inlineFields.length) {
    const owned = state.fields.filter(([path]) => inProvider(path));
    const actual = [...before.fields.values()].filter(({ path }) => inProvider(path) && path.length > 2);
    const whollyOwned = member?.node.value.type === "TOMLInlineTable" && actual.length === owned.length && actual.every(({ path, node }) => node.value.type === "TOMLValue" && owned.some(([expected, value]) => key(expected) === key(path) && value === getStaticTOMLValue(node.value)));
    const result = patch(text, state.fields.filter(([path]) => !inProvider(path)));
    // The inserted inline member is one owned unit. Preserve an extended or
    // rewritten member intact, including its required provider name.
    if (!whollyOwned) {
      result.retained.push(...owned.map(([path]) => path.join(".")), "provider retained for user settings");
      return result;
    }
    const node = document(result.text).fields.get(key(member.path)).node;
    const siblings = node.parent.type === "TOMLInlineTable" ? node.parent.body : [node], index = siblings.indexOf(node);
    const start = index > 0 ? siblings[index - 1].range[1] : node.range[0];
    const end = index === 0 && siblings[1] ? siblings[1].range[0] : node.range[1];
    result.text = result.text.slice(0, start) + result.text.slice(end);
    document(result.text);
    return result;
  }
  let patched = patch(text, state.fields);
  const { fields, tables } = document(patched.text);
  const table = tables.find((node) => inProvider(node.resolvedKey) && node.resolvedKey.length === 2);
  // Codex validates even unselected providers. User provider additions need
  // their required name; an empty generated header has no remaining owner.
  if ([...fields.values()].some(({ path }) => inProvider(path)) || tables.some((node) => inProvider(node.resolvedKey) && node.resolvedKey.length > 2)) {
    const name = state.fields.find(([path]) => inProvider(path) && path[2] === "name");
    if (!patched.retained.includes(name[0].join("."))) {
      patched = patch(text, state.fields.filter((field) => field !== name));
      patched.retained.push(name[0].join("."), "provider name retained for user provider settings");
    }
  } else if (table) {
    patched.text = patched.text.slice(0, table.range[0]) + patched.text.slice(table.range[1]);
  }
  document(patched.text);
  return patched;
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
  const prefix = marker(profile);
  if (!text?.startsWith(prefix)) throw new Error(profile === null ? "Desktop configuration is not owned by this setup" : "profile is not owned by this setup; choose another --profile");
  let state;
  try { state = JSON.parse(text.slice(prefix.length, text.indexOf("\n"))); }
  catch { throw new Error("profile ownership receipt is invalid"); }
  const allowed = new Set([
    ...rootFields.filter((name) => profile !== null || name !== "service_tier").map((name) => key([name])),
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
  if (profile === null) {
    const roots = state.fields.filter(([path]) => path.length === 1).map(([path]) => key(path));
    if (typeof state.rootExisted !== "boolean" || !Array.isArray(state.originals) || state.originals.length !== roots.length
      || state.originals.some((entry, index) => !Array.isArray(entry) || entry.length !== 2 || key(entry[0]) !== roots[index] || (entry[1] !== null && typeof entry[1] !== "string"))) throw new Error("Desktop restoration receipt is invalid");
    for (const [path, raw] of state.originals.filter(([, raw]) => raw !== null)) {
      const parsed = document(`${JSON.stringify(path[0])} = ${raw}\n`), field = parsed.fields.get(key(path));
      if (parsed.fields.size !== 1 || parsed.tables.length || field?.node.value.type !== "TOMLValue" || typeof getStaticTOMLValue(field.node.value) !== "string") throw new Error("Desktop restoration receipt is invalid");
    }
  }
  return state;
}

function baseCompatible(text, profile) {
  const { fields, tables } = document(text ?? "");
  for (const { path, node } of [...fields.values(), ...tables.map((node) => ({ path: node.resolvedKey }))]) {
    const target = path[0] === "model_providers" ? providerId(profile) : path[0] === "profiles" ? profile : null;
    const inlineCollision = target && path.length === 1 && node?.value.type === "TOMLInlineTable" && node.value.body.some((field) => getStaticTOMLValue(field.key)[0] === target);
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
    if (!["--target", "--router-url", "--provider", "--model", "--service-tier", "--profile", "--codex-home", "--codex", "--key-file"].includes(name)
      || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error("invalid arguments; use --help");
    if (Object.hasOwn(options, name)) throw new Error("duplicate argument; use --help");
    options[name] = rest[++index];
  }
  const target = options["--target"] ?? "cli";
  if (!["cli", "desktop"].includes(target)) throw new Error("target must be cli or desktop");
  if (target === "desktop" && (options["--profile"] || options["--service-tier"])) throw new Error("Desktop uses root configuration; --profile and --service-tier are CLI-only");
  const profile = target === "desktop" ? null : options["--profile"] ?? "clawrouter";
  if (profile !== null && (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile) || profile === "config")) throw new Error("profile must be 1–64 letters, digits, underscores, or hyphens, excluding config");
  if (command !== "connect" && ["--router-url", "--provider", "--model", "--service-tier"].some((name) => options[name])) throw new Error("connection settings belong to connect; remove and reconnect to change them");
  return { command, target, profile, home: resolve(options["--codex-home"] ?? env.CODEX_HOME ?? join(homedir(), ".codex")),
    routerUrl: options["--router-url"], provider: options["--provider"], model: options["--model"],
    serviceTier: options["--service-tier"] ?? "default", codex: options["--codex"],
    keyFile: options["--key-file"], dryRun: options.dryRun === true };
}

export async function manageCodex(args, env = process.env) {
  const options = parse(args, env);
  const { command, target, profile, home, dryRun } = options;
  const desktop = target === "desktop";
  const path = join(home, desktop ? "config.toml" : `${profile}.config.toml`);
  if (command === "connect" && (!options.routerUrl || !options.provider || !options.model || !["default", "priority"].includes(options.serviceTier))) throw new Error("connect requires --router-url, --provider, --model, and a valid --service-tier (default or priority)");
  const original = await readRegular(path);
  if (command === "connect" && (desktop ? original?.startsWith(DESKTOP_MARKER) : original !== null)) throw new Error(desktop ? "Desktop is already connected; use update or remove" : "profile already exists; use update or choose another --profile");
  if (command === "remove" && original === null) return { command, profile, status: "absent", revoked: false };
  const state = command === "connect" ? null : receipt(original, profile);
  const oldCatalog = state && join(home, catalogName(profile, state.catalogSha256));
  const oldBytes = oldCatalog && await readRegular(oldCatalog);
  let text, nextBytes, nextCatalog, nextState, retained = [];
  if (command === "remove") {
    const body = original.slice(original.indexOf("\n") + 1);
    const roots = state.fields.filter(([path]) => path.length === 1);
    // Root selectors form one routing decision. A partial restore could pair
    // a user's model with our provider/catalog, so conflicts retain everything.
    const conflicts = desktop ? patch(body, roots, roots).retained : [];
    if (conflicts.length) return { command, target, status: "retained", changed: [], retained: conflicts, revoked: false };
    const patched = removeOwned(body, desktop ? { ...state, fields: state.fields.filter(([path]) => path.length > 1) } : state);
    if (desktop) patched.text = patch(patched.text, roots, state.originals.filter(([, raw]) => raw !== null), true).text;
    text = patched.text;
    retained = patched.retained;
  } else {
    if (!desktop || command === "connect") baseCompatible(await readRegular(join(home, "config.toml")), profile);
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
    const installed = desktop && !state ? installDesktop(original ?? "", fields) : null;
    if (desktop) Object.assign(nextState, { originals: state?.originals ?? installed.originals, rootExisted: state?.rootExisted ?? original !== null });
    const body = state ? patch(original.slice(original.indexOf("\n") + 1), state.fields, fields).text : installed?.body ?? render(fields);
    text = `${marker(profile)}${JSON.stringify(nextState)}\n${body}`;
    document(text);
    nextCatalog = join(home, catalogName(profile, nextState.catalogSha256));
    if (command === "verify") {
      if (nextState.catalogSha256 !== state.catalogSha256 || JSON.stringify(fields) !== JSON.stringify(state.fields)) throw new Error("authorized catalog or transport changed; run update then restart Codex");
      return { command, target, profile, status: "verified", inferenceProbed: false, producer: catalog.producer };
    }
  }
  const changed = command === "remove" ? state.fields.map(([path]) => path.join(".")).filter((field) => !retained.includes(field))
    : nextState.fields.filter(([path, value]) => !state?.fields.some(([oldPath, oldValue]) => key(path) === key(oldPath) && value === oldValue)).map(([path]) => path.join("."));
  const summary = { command, target, profile, status: dryRun ? "planned" : "applied", changed, retained,
    ...(command === "remove" ? { revoked: false } : { catalogSha256: nextState.catalogSha256, restartRequired: true,
      ...(desktop ? { scope: "Desktop and unprofiled CLI root defaults", launch: "Fully quit and restart Desktop, then start a new thread; load CLAWROUTER_API_KEY from the interactive login shell." } : { launch: `CODEX_HOME=${shellQuote(home)} ${shellQuote(options.codex ?? "codex")} --profile ${profile}` }),
      credential: "CLAWROUTER_API_KEY must be exported in the Codex process environment" }) };
  if (dryRun) return summary;

  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, desktop ? ".clawrouter-desktop.lock" : `.${profile}.clawrouter-connect.lock`);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error(`another setup operation owns the ${desktop ? "root" : "profile"} lock; if interrupted, inspect it before removing the lock directory`); }
  let createdCatalog = false, committed = false;
  try {
    if (await readRegular(path) !== original) throw new Error("profile changed during the operation; no files changed");
    if (command !== "remove" && (!desktop || command === "connect")) baseCompatible(await readRegular(join(home, "config.toml")), profile);
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
      const restored = desktop ? document(text).fields.get(key(["model_catalog_json"])) : undefined;
      const restoredPointer = restored?.node.value.type === "TOMLValue" && getStaticTOMLValue(restored.node.value);
      const keepCatalogs = retained.includes("model_catalog_json") || retained.includes("provider retained for user settings") || typeof restoredPointer === "string" && state.catalogs.some((digest) => resolve(home, restoredPointer) === join(home, catalogName(profile, digest)));
      if (keepCatalogs) summary.retained.push(desktop ? "model catalogs retained for restored or user-owned settings" : "model catalogs retained because the catalog pointer changed");
      for (const digest of keepCatalogs ? [] : state.catalogs) {
        const name = catalogName(profile, digest);
        try {
          const current = await readRegular(join(home, name));
          if (current !== null && hash(current) === digest) await rm(join(home, name));
          else if (current !== null) summary.retained.push(`${name}: modified outside setup`);
        } catch { summary.retained.push(`${name}: could not be removed`); }
      }
      if (!text.trim() && (!desktop || !state.rootExisted)) {
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
    process.stdout.write("Usage: node scripts/codex-connect.mjs <connect|verify|update|remove> [--target cli|desktop] [--profile clawrouter] [--codex-home DIR] [--codex PATH] [--key-file PATH] [--dry-run]\nconnect requires --router-url ORIGIN --provider ID --model UPSTREAM_SLUG [--service-tier default|priority for CLI only].\nUses CLAWROUTER_API_KEY unless --key-file supplies it for this command. No key is stored. Start Codex with the environment key exported.\nCLI creates a separate profile. Desktop edits root routing defaults, also affecting unprofiled CLI; fully quit the app before changing them. Auth, sandbox, shell startup, and key files are untouched. Verify makes no inference calls. Remove does not revoke a key.\n");
  } else {
    manageCodex(process.argv.slice(2)).then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`)).catch((error) => {
      process.stderr.write(`Codex setup failed: ${error.code ? "filesystem operation failed" : error.message}\n`);
      process.exitCode = 1;
    });
  }
}
