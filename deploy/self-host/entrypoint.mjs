import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = join(root, ".wrangler.self-host.toml");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export function renderSelfHostConfig(source) {
  const output = [];
  let skippingSection = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:\[build\]|\[\[routes\]\])\s*(?:#.*)?$/.test(line)) {
      skippingSection = true;
      continue;
    }
    if (skippingSection && /^\s*\[/.test(line)) {
      skippingSection = false;
    }
    if (!skippingSection) output.push(line);
  }
  return `${output.join("\n").trim()}\n\n[[kv_namespaces]]\nbinding = "POLICY_KV"\nid = "self-host-local"\n`;
}

export function selfHostVariableNames(providerSnapshot, env) {
  const names = new Set(
    providerSnapshot.providers.flatMap((provider) => provider.config_keys ?? []),
  );
  for (const name of (env.CLAWROUTER_SELF_HOST_VARS ?? "").split(",")) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
      throw new Error(`invalid variable name in CLAWROUTER_SELF_HOST_VARS: ${trimmed}`);
    }
    if (trimmed === "CLAWROUTER_ADMIN_TOKEN") {
      throw new Error(
        "CLAWROUTER_ADMIN_TOKEN cannot be passed to the Worker; configure only its SHA-256 digest",
      );
    }
    names.add(trimmed);
  }
  names.delete("CLAWROUTER_ADMIN_TOKEN_SHA256");
  names.delete("CLAWROUTER_LOCAL_AUTH");
  names.delete("CLAWROUTER_LOCAL_ADMIN_EMAIL");
  names.delete("CLAWROUTER_PUBLIC_ORIGIN");
  return [...names]
    .filter((name) => env[name] !== undefined && env[name] !== "")
    .sort();
}

export function localAuthMode(env) {
  const value = (env.CLAWROUTER_LOCAL_AUTH ?? "disabled").trim().toLowerCase();
  if (!["enabled", "disabled"].includes(value)) {
    throw new Error('CLAWROUTER_LOCAL_AUTH must be "enabled" or "disabled"');
  }
  return value;
}

export function localAdminEmail(env) {
  const value = env.CLAWROUTER_LOCAL_ADMIN_EMAIL?.trim();
  if (value && !(value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value))) {
    throw new Error("CLAWROUTER_LOCAL_ADMIN_EMAIL must be a valid email address");
  }
  return value || null;
}

export function publicOrigin(env) {
  const value = env.CLAWROUTER_PUBLIC_ORIGIN?.trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLAWROUTER_PUBLIC_ORIGIN must be an absolute HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CLAWROUTER_PUBLIC_ORIGIN must be an absolute HTTP(S) origin without a path, query, fragment, or credentials");
  }
  return url.origin;
}

function main() {
  const adminTokenSha256 = process.env.CLAWROUTER_ADMIN_TOKEN_SHA256?.trim();
  if (!adminTokenSha256) {
    fail("CLAWROUTER_ADMIN_TOKEN_SHA256 is required; set it to the SHA-256 digest of the admin bearer token");
  }
  if (!/^[a-f0-9]{64}$/i.test(adminTokenSha256)) {
    fail("CLAWROUTER_ADMIN_TOKEN_SHA256 must be a 64-character hexadecimal SHA-256 digest");
  }

  let localAuth;
  let adminEmail;
  let externalOrigin;
  try {
    localAuth = localAuthMode(process.env);
    adminEmail = localAdminEmail(process.env);
    externalOrigin = publicOrigin(process.env);
  } catch (error) {
    fail(error.message);
  }

  const sourceConfig = readFileSync(join(root, "wrangler.toml"), "utf8");
  writeFileSync(configPath, renderSelfHostConfig(sourceConfig), { mode: 0o600 });

  const snapshot = JSON.parse(
    readFileSync(join(root, "worker/generated/provider-snapshot.json"), "utf8"),
  );
  const variableNames = selfHostVariableNames(snapshot, process.env);
  const args = [
    "dev",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8787",
    "--persist-to",
    "/data",
    "--config",
    configPath,
    "--var",
    `CLAWROUTER_ADMIN_TOKEN_SHA256:${adminTokenSha256}`,
    "--var",
    `CLAWROUTER_LOCAL_AUTH:${localAuth}`,
  ];
  if (adminEmail) {
    args.push("--var", `CLAWROUTER_LOCAL_ADMIN_EMAIL:${adminEmail}`);
  }
  if (externalOrigin) {
    args.push("--var", `CLAWROUTER_PUBLIC_ORIGIN:${externalOrigin}`);
  }
  // Wrangler redacts secret-shaped bindings; --var makes Docker env explicit to local workerd.
  for (const name of variableNames) {
    args.push("--var", `${name}:${process.env[name]}`);
  }

  const child = spawn(join(root, "node_modules/.bin/wrangler"), args, {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: "inherit",
  });
  const stopCleanup = startContentCleanup(child);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { stopCleanup(); child.kill(signal); });
  }
  child.on("error", (error) => fail(`could not start Wrangler: ${error.message}`));
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

export function startContentCleanup(child, baseUrl = "http://127.0.0.1:8787", { intervalMs = 60_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  child.once("exit", stop);
  child.once("error", stop);
  void (async () => {
    let ready = false;
    while (!controller.signal.aborted) {
      try {
        const options = { redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) };
        if (!ready) {
          const health = await fetchImpl(`${baseUrl}/v1/health`, options);
          if (!health.ok || (await health.json()).ok !== true) throw new Error("worker is not ready");
          ready = true;
        }
        // Local Wrangler does not run cron itself. Its native trigger returns JSON
        // only with format=json; a successful HTTP status alone is insufficient.
        const response = await fetchImpl(`${baseUrl}/cdn-cgi/local/scheduled?format=json`, options);
        if (!response.ok || (await response.json()).outcome !== "ok") throw new Error("cleanup did not complete");
      } catch {
        if (!controller.signal.aborted) console.error("clawrouter self-host: content cleanup retry; worker unavailable or sweep failed");
      }
      await delay(ready ? intervalMs : 1_000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })().finally(() => {
    child.removeListener("exit", stop);
    child.removeListener("error", stop);
  });
  return stop;
}

function fail(message) {
  console.error(`clawrouter self-host: ${message}`);
  process.exit(1);
}
