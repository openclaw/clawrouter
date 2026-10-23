import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { startLocalSearchFixture } from "./search-semantics-local-fixture.mjs";

export const tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const hostname = "funnel-fixture.example.invalid";
export const target = "http://127.0.0.1:18765";
const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const empty = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

export function ownedFunnel(config) {
  // Accept only the single foreground session this experiment expects. Unknown
  // config is never a reason to issue reset/off against another user's service.
  if (!config || Object.keys(config).length !== 1 || !config.Foreground) return false;
  const sessions = Object.values(config.Foreground);
  if (sessions.length !== 1) return false;
  const expected = { TCP: { "443": { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [`${hostname}:443`]: true } };
  try { assert.deepEqual(sessions[0], expected); return true; } catch { return false; }
}

export async function tailscaleStatus(run = execute) {
  const result = await run(tailscale, ["funnel", "status", "--json"], { timeout: 10_000, maxBuffer: 256 * 1024 });
  return JSON.parse(result.stdout);
}

export async function checkConnectedNode(run = execute) {
  const status = JSON.parse((await run(tailscale, ["status", "--json"], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  assert.equal(status.BackendState, "Running", "use the existing authenticated Tailscale connection");
  assert.equal(status.Self?.DNSName?.replace(/\.$/, ""), hostname, "current node must match the approved hostname");
  assert.ok(status.CurrentTailnet?.MagicDNSEnabled && status.CertDomains?.includes(hostname), "MagicDNS and certificate eligibility required");
  assert.ok(status.Self?.Capabilities?.includes("funnel") && status.Self?.Capabilities?.includes("https"), "existing Funnel and HTTPS permissions required");
}

// Only called by the separately authorized probe command. No fallback vault,
// account, enrollment or authentication mode. Never echo subprocess diagnostics.
export async function loadProbeKey(run = execute) {
  const base = `${homedir()}/.codex/skills/one-password/scripts/`;
  const options = { timeout: 15_000, maxBuffer: 64 * 1024 };
  const metadata = (await run(`${base}list-secret-fields`, ["Agent Secrets", "OpenAI"], options)).stdout;
  assert.ok(!/^field=ACCESS_INSTRUCTIONS .*state=set\b/m.test(metadata), "populated item instructions require operator review before proceeding");
  assert.equal((metadata.match(/^field=OPENAI_API_KEY .*state=set\b/gm) ?? []).length, 1, "expected one populated canonical key field");
  const key = (await run(`${base}op-with-service-account`, ["read", "op://Agent Secrets/OpenAI/OPENAI_API_KEY"], options)).stdout.trim();
  assert.ok(key.length, "key must be populated");
  return key;
}

export async function startFunnelExperiment({ approved = false, run = execute, launch = spawn, startFixture = startLocalSearchFixture, ttlMs = 600_000, readKey = loadProbeKey, probe, settle, signal } = {}) {
  assert.equal(approved, true, "public exposure requires explicit authorization");
  assert.ok(Number.isInteger(ttlMs) && ttlMs >= 120_000 && ttlMs <= 600_000, "exposure limited to at most ten minutes");
  signal?.throwIfAborted();
  await checkConnectedNode(run);
  assert.ok(empty(await tailscaleStatus(run)), "Serve/Funnel configuration must be empty");
  signal?.throwIfAborted();
  const fixture = await startFixture();
  let child, stopping, sessionId, stopped = false, ready = false, deadlineTimer;
  const expiresAt = Date.now() + ttlMs;
  async function stop() {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", autoStop);
    stopping = (async () => {
      // Closing the fixture first removes the content even if CLI cleanup fails.
      let fixtureClosed = false;
      try { await fixture.close(); fixtureClosed = true; } catch { /* Still end the owned CLI session. */ }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      // The foreground session belongs to this child. CLI "off" targets the
      // persistent config in 1.102.4, so it is not a foreground cleanup fallback.
      let config = await tailscaleStatus(run);
      for (let i = 0; i < 10 && ownedFunnel(config) && Object.keys(config.Foreground)[0] === sessionId; i++) { await delay(200); config = await tailscaleStatus(run); }
      const serve = JSON.parse((await run(tailscale, ["serve", "status", "--json"], { timeout: 10_000, maxBuffer: 256 * 1024 })).stdout);
      return { fixtureClosed, funnelEmpty: empty(config), serveEmpty: empty(serve) };
    })();
    return stopping;
  }
  let cleanupResult;
  const cleaned = new Promise(resolve => { cleanupResult = resolve; });
  const autoStop = () => { stop().then(cleanupResult, () => cleanupResult({ cleanupFailed: true })); };
  deadlineTimer = setTimeout(autoStop, ttlMs);
  signal?.addEventListener("abort", autoStop, { once: true });
  try {
    // Covers cancellation while the fixture listener was being acquired.
    signal?.throwIfAborted();
    child = launch(tailscale, ["funnel", "--https=443", target], { stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", autoStop);
    child.once("exit", () => { if (!stopped) autoStop(); });
    for (let i = 0; i < 30 && !stopped; i++) {
      const config = await tailscaleStatus(run);
      if (ownedFunnel(config)) { sessionId = Object.keys(config.Foreground)[0]; ready = true; break; }
      await delay(1_000);
    }
    assert.ok(ready && !stopped, "expected foreground Funnel mapping did not become ready");
  } catch {
    await stop().catch(() => {});
    throw new Error("Funnel startup failed; inspect read-only status before retrying");
  }
  return {
    url: `https://${hostname}/`, expiresAt: new Date(expiresAt).toISOString(), cleaned,
    snapshot: fixture.snapshot,
    confirmWitness: value => { assert.ok(!stopped); return fixture.confirmWitness(value); },
    arm: () => { assert.ok(!stopped); return fixture.arm(); },
    async measure({ approved: probeApproved = false } = {}) {
      assert.equal(probeApproved, true, "paid retrieval requires separate explicit authorization");
      assert.ok(!stopped && Date.now() + 110_000 < expiresAt, "insufficient exposure time for one bounded retrieval");
      assert.equal(fixture.snapshot().phase, "armed", "arm after outside-tailnet verification first");
      const key = await readKey();
      assert.ok(!stopped && Date.now() + 106_000 < expiresAt, "credential lookup consumed the measurement window");
      return fixture.measure({ key, url: `https://${hostname}/`, probe, settle });
    },
    stop,
  };
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ["--expose-approved"], "run only after public-exposure approval");
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  // Install before the first startup await: a foreground child must not outlive
  // an ordinary parent termination during readiness/certificate setup.
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try { await runInteractiveExperiment(abort.signal); }
  finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

async function runInteractiveExperiment(signal) {
  const experiment = await startFunnelExperiment({ approved: true, signal });
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({ event: "exposed", url: experiment.url, expiresAt: experiment.expiresAt });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const reportCleanup = (event, result) => {
    emit({ event, ...result });
    if (!result.fixtureClosed || !result.funnelEmpty || !result.serveEmpty) process.exitCode = 1;
  };
  const finish = async () => { input.close(); reportCleanup("cleanup", await experiment.stop()); };
  experiment.cleaned.then(result => { reportCleanup("automatic-cleanup", result); input.close(); });
  try {
    for await (const line of input) {
      try {
        if (line === "snapshot") emit(experiment.snapshot());
        else if (line.startsWith("witness ")) emit(experiment.confirmWitness(line.slice(8)));
        else if (line === "arm") emit(experiment.arm());
        else if (line === "probe-approved") { emit(await experiment.measure({ approved: true })); break; }
        else if (line === "stop") break;
        else emit({ commandRejected: true });
      } catch { emit({ commandFailed: true }); }
    }
  } finally { await finish(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("Funnel experiment failed; verify Serve/Funnel status and port 18765.\n"); process.exitCode = 1; });
}
