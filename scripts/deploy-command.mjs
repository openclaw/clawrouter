import { spawn } from 'node:child_process';
export function command(args, { env = process.env, timeout = 10 * 60_000, signal, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Deployment command cancelled')); return; }
    const child = spawn('pnpm', args, { env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, stopped = false, force;
    const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      killGroup('SIGTERM');
      force = setTimeout(() => killGroup('SIGKILL'), 5_000);
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort',stop,{once:true});
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return stop();
      stdout += chunk.toString(); if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return stop(); if (!quiet) process.stderr.write(chunk); });
    child.on('error', () => { clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort',stop); reject(new Error('Could not start deployment command')); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(force);
      signal?.removeEventListener('abort',stop);
      // Ensure a timed-out pnpm cannot leave Wrangler running after rollback.
      if (stopped) killGroup('SIGKILL');
      if (stopped || code !== 0) reject(new Error(`Deployment command ${args.slice(0, 3).join(' ')} failed or timed out`));
      else resolve(stdout);
    });
  });
}
