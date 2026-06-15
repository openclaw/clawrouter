import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

const legacy = readRecord(`keys/${kid}`, { allowMissing: true });
const credential =
  readRecord(`credentials/${kid}`, { allowMissing: true }) ?? legacyCredential(legacy);
const policy = readRecord(`policies/${kid}`, { allowMissing: true }) ?? legacyPolicy(legacy);
if (!credential || !policy) {
  throw new Error(`proxy credential or access policy ${kid} was not found`);
}
credential.enabled = false;
policy.enabled = false;
if (legacy) legacy.enabled = false;
const records = [
  ...(legacy ? [[`keys/${kid}`, writeJson(legacy, "legacy-key.json")]] : []),
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

console.log(`revoked proxy credential and access policy for ${kid}`);

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
    throw new Error(result.stderr || `${command} failed`);
  }
  return result;
}

function readRecord(key, { allowMissing = false } = {}) {
  const result = spawnSync("pnpm", [
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
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    if (allowMissing && /\b(not found|does not exist|missing)\b/i.test(message)) {
      return null;
    }
    throw new Error(message || `failed to read ${key}`);
  }
  if (!result.stdout.trim()) {
    if (allowMissing) return null;
    throw new Error(`empty response while reading ${key}`);
  }
  return JSON.parse(result.stdout);
}

function legacyCredential(legacy) {
  if (!legacy?.secretSha256) return null;
  return { enabled: legacy.enabled !== false, secretSha256: legacy.secretSha256, policyId: kid };
}

function legacyPolicy(legacy) {
  if (!legacy) return null;
  const { secretSha256: _, ...policy } = legacy;
  return policy;
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
