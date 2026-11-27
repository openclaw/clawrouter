import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

for (const failure of [false, true]) {
  test(`CLI ${failure ? 'failure' : 'success'} preserves awaited work and exits despite an unacknowledged WebSocket close`, async (t) => {
    const sockets = new Set();
    const server = createServer();
    server.on('upgrade', (request, socket) => {
      sockets.add(socket); socket.on('error', () => {});
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on('data', () => {}); // Deliberately never acknowledges the client's close.
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const source = `import { runDeployCli } from ${JSON.stringify(new URL('../scripts/deploy-cli.mjs', import.meta.url).href)};
      await runDeployCli(async () => {
        const socket = new WebSocket('ws://127.0.0.1:${server.address().port}');
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        await new Promise(resolve => setTimeout(resolve, 50));
        socket.close();
        console.log('mandatory-work-and-cleanup-complete');
        ${failure ? "throw new Error('fixture operation failed');" : ''}
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    let timer;
    const result = await Promise.race([once(child, 'close'), new Promise((resolve) => { timer = setTimeout(() => resolve(['timeout']), 3_000); })]);
    clearTimeout(timer);
    assert.equal(result[0], failure ? 1 : 0, stderr);
    assert.match(stdout, /mandatory-work-and-cleanup-complete/);
    if (failure) assert.match(stderr, /fixture operation failed/);
  });
}
