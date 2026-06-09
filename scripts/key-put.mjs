import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const secret = readSecret(args);
const providers = args.providers ? args.providers.split(",").filter(Boolean) : [];
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";
const enabled = args.disabled ? false : true;
const tenantId = args.tenant ?? "default";
const monthlyBudgetMicros = args["monthly-budget-micros"]
  ? parseNonNegativeInteger(args["monthly-budget-micros"], "--monthly-budget-micros")
  : undefined;
const requestCostMicros = args["request-cost-micros"]
  ? parseNonNegativeInteger(args["request-cost-micros"], "--request-cost-micros")
  : undefined;

const policy = {
  enabled,
  secretSha256: createHash("sha256").update(secret).digest("hex"),
  providers,
  tenantId,
};
if (monthlyBudgetMicros !== undefined) {
  policy.monthlyBudgetMicros = monthlyBudgetMicros;
}
if (requestCostMicros !== undefined) {
  policy.requestCostMicros = requestCostMicros;
}

const policyPath = writeSecretJson(policy);

try {
  run("pnpm", [
    "exec",
    "wrangler",
    "kv",
    "key",
    "put",
    `keys/${kid}`,
    "--path",
    policyPath,
    "--binding",
    binding,
    "--config",
    config,
    ...kvTargetArgs(args),
  ]);
} finally {
  rmSync(policyPath, { force: true });
  rmSync(join(policyPath, ".."), { force: true, recursive: true });
}

console.log(`stored key policy for ${kid}; secret was not printed`);

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

function readSecret(args) {
  if (args.secret) {
    throw new Error(
      "--secret would expose the proxy secret in process argv; use --secret-stdin, --secret-env, or --secret-file",
    );
  }
  if (args["secret-env"]) {
    return required(process.env[args["secret-env"]], `env ${args["secret-env"]}`);
  }
  if (args["secret-file"]) {
    return required(readFileSync(args["secret-file"], "utf8").trim(), "--secret-file");
  }
  if (args["secret-stdin"]) {
    return required(readFileSync(0, "utf8").trim(), "stdin secret");
  }
  throw new Error("--secret-stdin, --secret-env, or --secret-file is required");
}

function parseNonNegativeInteger(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be less than or equal to Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed`);
  }
}

function writeSecretJson(value) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}

function kvTargetArgs(args) {
  if (args.local) {
    return ["--preview", "false"];
  }
  return ["--remote", "--preview", "false"];
}
