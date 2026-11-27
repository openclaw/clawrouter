// A closed Cloudflare tail may retain a native WebSocket handle while waiting
// for the peer's close handshake. CLI completion must follow awaited work and
// cleanup, not that optional socket's lifetime. No deploy commands are detached.
export async function runDeployCli(operation) {
  try { await operation(); }
  catch (error) { console.error(error); process.exitCode = 1; }
  let timer;
  try {
    await Promise.race([
      Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', resolve)))),
      new Promise((resolve) => { timer = setTimeout(resolve, 1_000); }),
    ]);
  } finally { clearTimeout(timer); }
  process.exit(process.exitCode ?? 0);
}
