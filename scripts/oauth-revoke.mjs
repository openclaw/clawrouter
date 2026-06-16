import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = args.kid;
const tenant = args.tenant;
const tokenRef = required(args["token-ref"] ?? args.provider, "--token-ref or --provider");
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

if (Boolean(kid) === Boolean(tenant)) {
  throw new Error("exactly one of --kid or --tenant is required");
}

const key = kid ? `oauth/${kid}/${tokenRef}` : `oauth/tenants/${tenant}/${tokenRef}`;
const existing = run("pnpm", [
  "exec",
  "wrangler",
  "kv",
  "key",
  "get",
  key,
  "--binding",
  binding,
  "--config",
  config,
  ...kvTargetArgs(args),
]);

const grant = revokeGrant(existing.stdout);
const grantPath = writeSecretJson(grant);

try {
  run("pnpm", [
    "exec",
    "wrangler",
    "kv",
    "key",
    "put",
    key,
    "--path",
    grantPath,
    "--binding",
    binding,
    "--config",
    config,
    ...kvTargetArgs(args),
  ]);
} finally {
  rmSync(grantPath, { force: true });
  rmSync(join(grantPath, ".."), { force: true, recursive: true });
}

console.log(`revoked upstream grant ${key}; tombstone contains no secrets`);

function revokeGrant(raw) {
  const trimmed = raw.trim();
  const revokedAt = new Date().toISOString();
  const metadata = parseMetadata(trimmed);
  canonicalizeAlias(metadata, "tokenType", "token_type");
  canonicalizeAlias(metadata, "expiresAt", "expires_at");
  canonicalizeAlias(metadata, "accountId", "account_id");
  canonicalizeAlias(metadata, "createdAt", "created_at");
  canonicalizeAlias(metadata, "updatedAt", "updated_at");
  canonicalizeAlias(metadata, "revokedAt", "revoked_at");
  if (args.kind !== undefined) {
    metadata.kind = parseKind(requiredOption(args, "kind"));
  }
  if (args.provider !== undefined) {
    metadata.provider = requiredOption(args, "provider");
  }
  if (args.label !== undefined) {
    metadata.label = requiredOption(args, "label");
  }
  return {
    ...stripSecrets(metadata),
    version: 1,
    enabled: false,
    tokenType: metadata.tokenType ?? "Bearer",
    updatedAt: revokedAt,
    revokedAt,
  };
}

function parseMetadata(value) {
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  }
  return {};
}

function canonicalizeAlias(target, canonical, alias) {
  if (target[canonical] === undefined && target[alias] !== undefined) {
    target[canonical] = target[alias];
  }
  delete target[alias];
}

function stripSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const secretFields = new Set([
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "credential",
    "credentials",
    "apiKey",
    "api_key",
    "token",
    "secret",
    "clientSecret",
    "client_secret",
    "password",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !secretFields.has(name))
      .map(([name, item]) => [name, stripSecrets(item)]),
  );
}

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      continue;
    }
    const name = value.slice(2);
    if (values[i + 1] && !values[i + 1].startsWith("--")) {
      out[name] = values[i + 1];
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredOption(args, name) {
  const value = args[name];
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  return required(value, `--${name}`);
}

function parseKind(value) {
  if (!["api_key", "oauth", "subscription"].includes(value)) {
    throw new Error("--kind must be api_key, oauth, or subscription");
  }
  return value;
}

function kvTargetArgs(args) {
  if (args.local) {
    return ["--preview", "false"];
  }
  return ["--remote", "--preview", "false"];
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed`);
  }
  return result;
}

function writeSecretJson(value) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-oauth-"));
  const path = join(dir, "grant.json");
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}
