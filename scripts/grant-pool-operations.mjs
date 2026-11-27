import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRequest } from "./admin-api.mjs";

const TARGET = "https://clawrouter.openclaw.ai";
const DIAGNOSTICS = {
  invalid_target: "Account inventory requires the fixed production HTTPS target.",
  invalid_inventory: "The API-visible inventory is malformed; inspect it in the private console.",
  inventory_failed: "Inventory requires working administrator access; inspect the private console.",
};

class OperationFailure extends Error {
  constructor(code) { super(DIAGNOSTICS[code]); this.code = code; }
}
function fail(code) { throw new OperationFailure(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function inventorySummary(value) {
  if (!record(value) || !Array.isArray(value.grants)) fail("invalid_inventory");
  const keys = new Set();
  const grants = value.grants.map(grant => {
    if (!record(grant) || typeof grant.key !== "string") fail("invalid_inventory");
    const parts = grant.key.split("/");
    if (parts[0] !== "oauth" || parts.length !== (parts[1] === "tenants" ? 4 : 3)
      || parts.slice(1).some(part => !part || part.length > 256 || /[\u0000-\u001f\u007f]/.test(part))
      || keys.has(grant.key) || typeof grant.enabled !== "boolean") fail("invalid_inventory");
    keys.add(grant.key);
    const provider = grant.provider ?? null, kind = grant.kind ?? null;
    const updatedAt = grant.updatedAt ?? null, revokedAt = grant.revokedAt ?? null;
    const credentialStatus = grant.credentialStatus ?? null;
    // The admin DTO passes legacy strings through. Observe their exact bytes;
    // current write-time enums and timestamp formats cannot gate inventory.
    if ([provider, kind, updatedAt, revokedAt, credentialStatus].some(value => value !== null && typeof value !== "string")) fail("invalid_inventory");
    return { key: grant.key, provider, kind, enabled: grant.enabled, updatedAt, revokedAt, credentialStatus };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  // This hashes only the API projection. Missing KV values and index-only owners
  // remain outside it; even an empty digest cannot attest complete storage.
  const schema = "clawrouter.api-visible-grants.v1";
  return {
    schema, count: grants.length,
    enabled: grants.filter(grant => grant.enabled).length,
    disabled: grants.filter(grant => !grant.enabled).length,
    revoked: grants.filter(grant => Boolean(grant.revokedAt)).length,
    sha256: digest({ schema, grants }),
    keyNamesSha256: digest({ schema: "clawrouter.api-visible-grant-keys.v1", keys: grants.map(grant => grant.key) }),
  };
}

export async function runGrantPoolOperation({ env = process.env, request } = {}) {
  try {
    // Validate the destination before adminRequest can attach any credentials.
    if (env.CLAWROUTER_BASE_URL !== TARGET) fail("invalid_target");
    const call = request ?? ((path, options) => adminRequest(path, { ...options, env, signal: AbortSignal.timeout(30_000) }));
    const inventory = inventorySummary(await call("/v1/admin/upstream-grants", { method: "GET" }));
    return {
      schema: "clawrouter.account-routing-operation.v1", operation: "inventory", execution: "operator", target: TARGET,
      inventory, result: "inventory_read",
    };
  } catch (error) {
    // Admin errors can contain private server details. Never surface their
    // message, cause or stack in the operator receipt.
    if (error instanceof OperationFailure) throw error;
    fail("inventory_failed");
  }
}

export async function grantPoolOperationsMain({ env = process.env, request, write = console.log } = {}) {
  try {
    write(JSON.stringify(await runGrantPoolOperation({ env, request })));
    return 0;
  } catch (error) {
    const code = error instanceof OperationFailure ? error.code : "inventory_failed";
    write(JSON.stringify({ result: "failed", code, hint: DIAGNOSTICS[code] }));
    return 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = await grantPoolOperationsMain();
}
