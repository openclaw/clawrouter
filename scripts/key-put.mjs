import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminRequest } from "./admin-api.mjs";

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
const request = {
  enabled,
  providers,
  allProviders,
  tenantId,
  secretSha256: createHash("sha256").update(secret).digest("hex"),
};
if (monthlyBudgetMicros !== undefined) {
  request.monthlyBudgetMicros = monthlyBudgetMicros;
}
if (requestCostMicros !== undefined) {
  request.requestCostMicros = requestCostMicros;
}

if (!args.local) {
  await adminRequest(`/v1/admin/keys/${encodeURIComponent(kid)}`, {
    method: "PUT",
    body: request,
  });
  console.log(
    `stored authoritative access policy and proxy credential for ${kid}; secret was not printed`,
  );
} else {
  putLocalBootstrapRecords(request);
  console.log(
    `bootstrapped local KV access policy and proxy credential for ${kid}; secret was not printed`,
  );
}

function putLocalBootstrapRecords(request) {
  const existingPolicy = readRecord(`policies/${kid}`, { allowMissing: true });
  const existingLegacy = readRecord(`keys/${kid}`, { allowMissing: true });
  const existingCredential =
    readRecord(`credentials/${kid}`, { allowMissing: true }) ?? legacyCredential(existingLegacy);
  const generation = existingPolicy?.generation ?? `policy_${randomUUID()}`;
  const policy = { ...request, generation };
  delete policy.allProviders;
  delete policy.secretSha256;
  const credential = {
    enabled,
    secretSha256: request.secretSha256,
    policyId: kid,
    policyGeneration: generation,
  };
  if (
    existingPolicy &&
    existingCredential &&
    policyChanged(existingPolicy, policy) &&
    existingCredential.secretSha256 !== credential.secretSha256
  ) {
    throw new Error(
      "cannot change policy scope and secret together; update the canonical policy and credential separately",
    );
  }
  const legacy = { ...policy, secretSha256: credential.secretSha256 };
  const tombstoneCredential = { ...credential, enabled: false };
  const tombstoneLegacy = { ...legacy, enabled: false };
  const tombstonePolicy = { ...policy, enabled: false };
  const records = [
    [`credentials/${kid}`, writeJson(tombstoneCredential, "credential-tombstone.json")],
    [`keys/${kid}`, writeJson(tombstoneLegacy, "legacy-key-tombstone.json")],
    [`policies/${kid}`, writeJson(tombstonePolicy, "policy-tombstone.json")],
    [`credentials/${kid}`, writeJson(credential, "credential.json")],
    [`policies/${kid}`, writeJson(policy, "policy.json")],
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

function readRecord(key, { allowMissing = false } = {}) {
  const result = spawnSync(
    "pnpm",
    [
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
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    if (allowMissing && /\b(not found|does not exist|missing)\b/i.test(message)) {
      return null;
    }
    throw new Error(message || `failed to read ${key}`);
  }
  const output = result.stdout.trim();
  if (allowMissing && isMissingRecordOutput(output)) {
    return null;
  }
  if (!output) {
    if (allowMissing) return null;
    throw new Error(`empty response while reading ${key}`);
  }
  return JSON.parse(output);
}

function isMissingRecordOutput(value) {
  return /^(?:value\s+)?not found$/i.test(value.trim());
}

function legacyCredential(legacy) {
  if (!legacy?.secretSha256) return null;
  return {
    enabled: legacy.enabled !== false,
    secretSha256: legacy.secretSha256,
    policyId: kid,
    policyGeneration: legacy.generation ?? "legacy",
  };
}

function policyChanged(existing, next) {
  return JSON.stringify(policyFields(existing)) !== JSON.stringify(policyFields(next));
}

function policyFields(policy) {
  return {
    enabled: policy.enabled !== false,
    providers: policy.providers ?? [],
    tenantId: policy.tenantId ?? null,
    tokenRole: policy.tokenRole ?? null,
    monthlyBudgetMicros: policy.monthlyBudgetMicros ?? null,
    requestCostMicros: policy.requestCostMicros ?? null,
  };
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
