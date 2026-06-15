import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const secret = readSecret(args);
const allProviders = args["all-providers"] === true;
if (args["all-providers"] !== undefined && !allProviders) {
  throw new Error("--all-providers is a flag and does not accept a value");
}
if (args.providers && allProviders) {
  throw new Error("--providers and --all-providers are mutually exclusive");
}
const providers =
  typeof args.providers === "string"
    ? [...new Set(args.providers.split(",").map((provider) => provider.trim()).filter(Boolean))]
    : [];
if (!allProviders && providers.length === 0) {
  throw new Error("--providers or --all-providers is required");
}
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
const generation = `policy_${randomUUID()}`;

const policy = {
  enabled,
  generation,
  providers,
  tenantId,
};
if (monthlyBudgetMicros !== undefined) {
  policy.monthlyBudgetMicros = monthlyBudgetMicros;
}
if (requestCostMicros !== undefined) {
  policy.requestCostMicros = requestCostMicros;
}

const credential = {
  enabled,
  secretSha256: createHash("sha256").update(secret).digest("hex"),
  policyId: kid,
  policyGeneration: generation,
};
const legacy = { ...policy, secretSha256: credential.secretSha256 };
const tombstoneCredential = { ...credential, enabled: false };
const tombstoneLegacy = { ...legacy, enabled: false };
const records = [
  [`credentials/${kid}`, writeJson(tombstoneCredential, "credential-tombstone.json")],
  [`keys/${kid}`, writeJson(tombstoneLegacy, "legacy-key-tombstone.json")],
  [`policies/${kid}`, writeJson(policy, "policy.json")],
  [`keys/${kid}`, writeJson(legacy, "legacy-key.json")],
  [`credentials/${kid}`, writeJson(credential, "credential.json")],
];

try {
  for (const [key, path] of records) {
    run("pnpm", [
      "exec",
      "wrangler",
      "kv",
      "key",
      "put",
      key,
      "--path",
      path,
      "--binding",
      binding,
      "--config",
      config,
      ...kvTargetArgs(args),
    ]);
  }
} finally {
  for (const [, path] of records) {
    rmSync(path, { force: true });
    rmSync(join(path, ".."), { force: true, recursive: true });
  }
}

console.log(`stored access policy and proxy credential for ${kid}; secret was not printed`);

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

function writeJson(value, name) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}

function kvTargetArgs(args) {
  if (args.local) {
    return ["--preview", "false"];
  }
  return ["--remote", "--preview", "false"];
}
