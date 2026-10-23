import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { get } from "node:https";
import { isIP } from "node:net";

// Ephemeral, deliberately public synthetic page. No production deployment,
// credentials, model text, request headers, or IP addresses are retained.
export async function startSearchOrigin(home) {
  const nonce = randomUUID(), marker = `ClawRouterProbe${randomUUID().replaceAll("-", "")}`;
  let hits = 0, robots = 0, tunnel, stopped = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path === "/health") { response.writeHead(404); response.end(); return; }
    if (path === "/robots.txt") { robots++; response.writeHead(200, { "content-type": "text/plain" }); response.end("User-agent: *\nAllow: /\n"); return; }
    hits++;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><title>ClawRouter synthetic probe</title><p>${marker}</p><a href="https://openai.com/">OpenAI</a>`);
  });
  async function close() {
    if (stopped) return; stopped = true;
    if (tunnel && tunnel.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => { tunnel.kill("SIGKILL"); resolve(); }, 2000);
      tunnel.once("exit", () => { clearTimeout(timer); resolve(); }); tunnel.kill("SIGTERM");
    });
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${server.address().port}`, "--no-autoupdate", "--protocol", "http2"], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    const origin = await new Promise((resolve, reject) => {
      let metadata = "";
      const timer = setTimeout(() => reject(new Error("public probe tunnel readiness timed out")), 40000);
      const fail = () => { clearTimeout(timer); reject(new Error("public probe tunnel unavailable")); };
      tunnel.once("error", fail); tunnel.once("exit", fail);
      tunnel.stderr.on("data", chunk => {
        metadata = (metadata + chunk.toString()).slice(-16384);
        const url = metadata.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (url && !/https:\/\/(?:api|www)\./.test(url[0]) && metadata.includes("Registered tunnel connection")) { clearTimeout(timer); resolve(url[0]); }
      });
    });
    // Wait for registration before DNS lookup to avoid caching a pre-creation
    // negative answer. Never request or prime the unique probe page locally.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const hostname = new URL(origin).hostname;
    const dns = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`, { signal: AbortSignal.timeout(5000) });
    const record = await dns.json(), address = record.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4)?.data;
    assert.ok(record.Status === 0 && address, "public DNS resolves the controlled origin");
    let ready = false;
    for (let attempt = 0; attempt < 10 && !ready; attempt++) {
      try { ready = await new Promise((resolve, reject) => {
        const request = get(`${origin}/health`, { signal: AbortSignal.timeout(3000), lookup(_host, options, callback) {
          callback(null, options.all ? [{ address, family: 4 }] : address, 4);
        } }, response => { response.resume(); resolve(response.statusCode === 404); });
        request.once("error", reject);
      }); } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(ready, "controlled public origin is reachable");
    return { url: `${origin}/probe/${nonce}`, marker, count: () => hits, robots: () => robots, close };
  } catch (error) { await close(); throw error; }
}
