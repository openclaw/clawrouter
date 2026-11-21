import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

export function nativeCodexClient(t, binary, home, env, onRequest) {
  // Routing fixtures do not use plugins. Their background Git checkout can
  // outlive app-server shutdown and write into the home during its removal.
  const child = spawn(binary, ["-c", "features.plugins=false", "app-server", "--listen", "stdio://"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(), notifications = [], errors = [];
  let nextId = 0, stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32_768); });
  const fail = (message) => {
    errors.push(message);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  };
  child.once("error", () => fail("native Codex failed to start"));
  child.once("exit", () => { if (pending.size) fail("native Codex exited before its RPC response"); });
  t.signal.addEventListener("abort", () => fail("native Codex fixture timed out"), { once: true });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id != null && message.method) {
      if (!onRequest) { fail(`unexpected client approval RPC ${message.method}`); return; }
      Promise.resolve().then(() => onRequest(message)).then(result => {
        child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }, () => fail(`native client request failed: ${message.method}`));
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    } else notifications.push(message);
  });
  return {
    child, notifications, errors, stderr: () => stderr,
    rpc: (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`native RPC ${method} timed out`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }),
    async close() {
      if (child.pid && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await exited; clearTimeout(force);
      }
    },
  };
}
