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

if (!kid && !tenant) {
  throw new Error("--kid or --tenant is required");
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
  ]);
} finally {
  rmSync(grantPath, { force: true });
  rmSync(join(grantPath, ".."), { force: true, recursive: true });
}

console.log(`revoked OAuth grant ${key}`);

function revokeGrant(raw) {
  const trimmed = raw.trim();
  const revokedAt = new Date().toISOString();
  if (trimmed.startsWith("{")) {
    const grant = JSON.parse(trimmed);
    return {
      enabled: false,
      tokenType: grant.tokenType ?? grant.token_type ?? "Bearer",
      revokedAt,
    };
  }
  return {
    enabled: false,
    tokenType: "Bearer",
    revokedAt,
  };
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
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(" ")} failed`);
  }
  return result;
}

function writeSecretJson(value) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-oauth-"));
  const path = join(dir, "grant.json");
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}
