import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function readLocalKeyRecord(key, { binding, config, allowMissing = false }) {
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
      "--preview",
      "false",
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

export function legacyCredential(legacy, policyId) {
  if (!legacy?.secretSha256) return null;
  return {
    enabled: legacy.enabled !== false,
    secretSha256: legacy.secretSha256,
    policyId,
    policyGeneration: legacy.generation ?? "legacy",
  };
}

export function writeKeyJson(value, name) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-key-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}

