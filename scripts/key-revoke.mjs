import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { legacyCredential, readLocalKeyRecord, writeKeyJson } from "./local-key-kv.mjs";
import { parseArgs } from "./cli-args.mjs";
import { adminRequest } from "./admin-api.mjs";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

if (!args.local) {
  await adminRequest(`/v1/admin/keys/${encodeURIComponent(kid)}/revoke`, {
    method: "POST",
  });
  console.log(`revoked authoritative proxy credential ${kid}`);
} else {
  revokeLocalBootstrapRecord();
  console.log(`revoked local KV proxy credential ${kid}`);
}

function revokeLocalBootstrapRecord() {
  const legacy = readLocalKeyRecord(`keys/${kid}`, { binding, config, allowMissing: true });
  const credential =
    readLocalKeyRecord(`credentials/${kid}`, { binding, config, allowMissing: true }) ?? legacyCredential(legacy, kid);
  if (!credential) {
    throw new Error(`proxy credential ${kid} was not found`);
  }
  credential.enabled = false;
  if (legacy) legacy.enabled = false;
  const records = [
    [`credentials/${kid}`, writeKeyJson(credential, "credential.json")],
    ...(legacy ? [[`keys/${kid}`, writeKeyJson(legacy, "legacy-key.json")]] : []),
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
        "--preview",
        "false",
      ]);
    }
  } finally {
    for (const [, path] of records) {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { force: true, recursive: true });
    }
  }
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
