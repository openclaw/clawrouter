import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = args.kid;
const tenant = args.tenant;
const tokenRef = required(args["token-ref"] ?? args.provider, "--token-ref or --provider");
const accessToken = readAccessToken(args);
const tokenType = args["token-type"] ?? "Bearer";
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

if (!kid && !tenant) {
  throw new Error("--kid or --tenant is required");
}

const key = kid ? `oauth/${kid}/${tokenRef}` : `oauth/tenants/${tenant}/${tokenRef}`;
const grant = {
  enabled: true,
  accessToken,
  tokenType,
};
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

console.log(`stored OAuth grant ${key}; token was not printed`);

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

function readAccessToken(args) {
  if (args["access-token"]) {
    throw new Error(
      "--access-token would expose the token in process argv; use --access-token-stdin, --access-token-env, or --access-token-file",
    );
  }
  if (args["access-token-env"]) {
    return required(process.env[args["access-token-env"]], `env ${args["access-token-env"]}`);
  }
  if (args["access-token-file"]) {
    return required(readFileSync(args["access-token-file"], "utf8").trim(), "--access-token-file");
  }
  if (args["access-token-stdin"]) {
    return required(readFileSync(0, "utf8").trim(), "stdin token");
  }
  throw new Error("--access-token-stdin, --access-token-env, or --access-token-file is required");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function writeSecretJson(value) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-oauth-"));
  const path = join(dir, "grant.json");
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}
