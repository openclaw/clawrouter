import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { adminRequest } from "./admin-api.mjs";

const baseUrl = requiredEnv("CLAWROUTER_BASE_URL").replace(/\/$/, "");
requiredEnv("CLAWROUTER_ADMIN_TOKEN");

const suffix = randomBytes(6).toString("hex");
const credentialId = `self_host_smoke_${suffix}`;
const proxySecret = randomBytes(24).toString("base64url");
const proxyKey = `clawrouter-live-${credentialId}-${proxySecret}`;
let created = false;

try {
  const health = await waitForHealth();
  assert.equal(health.ok, true, "health response must report ok");

  await adminRequest(`/v1/admin/keys/${credentialId}`, {
    method: "PUT",
    body: {
      enabled: true,
      providers: ["firecrawl"],
      allProviders: false,
      tenantId: "self-host-smoke",
      secretSha256: createHash("sha256").update(proxySecret).digest("hex"),
      requestCostMicros: 1,
    },
    signal: AbortSignal.timeout(10_000),
  });
  created = true;

  const catalogResponse = await fetch(`${baseUrl}/v1/catalog`, {
    headers: { authorization: `Bearer ${proxyKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
  assert.ok(
    catalog.providers?.some((provider) => provider.id === "firecrawl"),
    "credential-scoped catalog must include firecrawl",
  );

  await revoke();
  created = false;
  console.log("self-host smoke ok: health, admin mutation, scoped catalog, revocation");
} finally {
  if (created) await revoke();
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json();
      if (response.ok) return body;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`self-host health did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function revoke() {
  await adminRequest(`/v1/admin/keys/${credentialId}/revoke`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  await adminRequest(`/v1/admin/policies/${credentialId}/revoke`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
