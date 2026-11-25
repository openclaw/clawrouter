import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const wrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const miniflare = createRequire(wrangler.resolve('miniflare/package.json'));
const NodeWebSocket = miniflare('ws');
const wsDirectory = dirname(miniflare.resolve('ws/package.json'));
const { kWebSocket } = miniflare(join(wsDirectory, 'lib/constants.js'));
const requestStart = channel('http.client.request.start');
const realtimePath = '/v1/realtime?model=gpt-realtime-2.1';

// Observe only the Node transport used by one real Miniflare dispatch. The
// receiver listener runs before ws's unchanged close-acknowledgement handler.
export function createWsCloseObservation(runtimeURL) {
  if (process.version !== 'v24.22.1' || wrangler('miniflare/package.json').version !== '5.20261023.3-beta' || miniflare('ws/package.json').version !== '8.21.0') {
    throw new Error('close observation requires the qualified Node/Miniflare/ws versions');
  }
  const origin = new URL(runtimeURL), scope = new AsyncLocalStorage(), token = {};
  let requests = 0, upgrades = 0, count = 0, receiverConcludeAt = null, preCloseFrameReceived = null;
  let invalid = false, callbackError = false, transportError = false, acquired = false, closed = false;
  let request, upgradeObserver, backing, receiver, concludeObserver, closeObserver, errorObserver, closePromise;
  const invalidate = () => { invalid = true; };
  const guarded = callback => (...args) => {
    try { callback(...args); } catch { callbackError = true; invalidate(); }
  };
  const removeUpgradeObserver = () => {
    if (request && upgradeObserver) request.removeListener('upgrade', upgradeObserver);
  };
  const subscriber = guarded(({ request: candidate }) => {
    if (scope.getStore() !== token) return;
    requests = Math.min(2, requests + 1);
    if (requests !== 1 || candidate.method !== 'GET' || candidate.protocol !== origin.protocol || candidate.getHeader('host') !== origin.host || candidate.path !== realtimePath || candidate.getHeader('upgrade') !== 'websocket') {
      invalidate(); return;
    }
    request = candidate;
    const originalUpgrade = request.rawListeners('upgrade');
    if (originalUpgrade.length !== 1) { invalidate(); return; }
    upgradeObserver = guarded((_response, socket) => {
      upgrades = Math.min(2, upgrades + 1);
      if (upgrades !== 1) { invalidate(); return; }
      const listeners = request.rawListeners('upgrade');
      const ws = socket[kWebSocket];
      if (!(ws instanceof NodeWebSocket)) { invalidate(); return; }
      backing = ws;
      // Observe actual WebSocket closure early, including a later validation
      // failure. ClientRequest.close and error are not closure evidence.
      let resolveClose;
      closePromise = new Promise(resolve => { resolveClose = resolve; });
      closeObserver = guarded(() => { closed = true; resolveClose(); });
      backing.on('close', closeObserver);
      errorObserver = guarded(() => { transportError = true; invalidate(); });
      backing.on('error', errorObserver);
      receiver = backing._receiver;
      if (listeners.length !== 2 || listeners[0] !== originalUpgrade[0] || listeners[1] !== upgradeObserver || backing._socket !== socket || !(receiver instanceof NodeWebSocket.Receiver) || receiver[kWebSocket] !== backing || backing.readyState !== NodeWebSocket.OPEN || backing._closeFrameReceived !== false) {
        invalidate(); return;
      }
      const originalConclude = receiver.rawListeners('conclude');
      if (originalConclude.length !== 1 || originalConclude[0].name !== 'receiverOnConclude') { invalidate(); return; }
      concludeObserver = guarded(() => {
        count = Math.min(2, count + 1);
        if (count !== 1) { invalidate(); return; }
        receiverConcludeAt = Date.now();
        preCloseFrameReceived = backing._closeFrameReceived;
        if (preCloseFrameReceived !== false) invalidate();
      });
      receiver.prependListener('conclude', concludeObserver);
      const installed = receiver.rawListeners('conclude');
      acquired = installed.length === 2 && installed[0] === concludeObserver && installed[1] === originalConclude[0];
      if (!acquired) invalidate();
    });
    request.on('upgrade', upgradeObserver);
  });

  return {
    async capture(dispatch) {
      requestStart.subscribe(subscriber);
      try { return await scope.run(token, dispatch); }
      finally {
        requestStart.unsubscribe(subscriber);
        try { removeUpgradeObserver(); } catch { callbackError = true; invalidate(); }
      }
    },
    // The caller must register any returned Miniflare socket for cleanup first.
    assertAcquired() {
      if (invalid || !acquired || requests !== 1 || upgrades !== 1) throw new Error('invalid selected WebSocket close observation');
    },
    snapshot(changed, clientClosedAt) {
      const valid = !invalid && acquired && requests === 1 && upgrades === 1 && count === 1 && preCloseFrameReceived === false && Number.isFinite(receiverConcludeAt);
      const measured = valid && Number.isFinite(changed) && Number.isFinite(clientClosedAt) && changed <= receiverConcludeAt && receiverConcludeAt <= clientClosedAt;
      return { clock: 'host Date.now', valid: measured, requests, upgrades, count, receiverConcludeAt, preCloseFrameReceived, callbackError, transportError,
        changedToConcludeMs: measured ? receiverConcludeAt - changed : null,
        concludeToClientCloseMs: measured ? clientClosedAt - receiverConcludeAt : null };
    },
    async finish() {
      try {
        // Called AFTER the fixture's normal socket close, drain and Miniflare
        // disposal. Missing closure fails; it never adds a new wait/deadline.
        if (!backing || !closed) throw new Error('backing WebSocket close not observed after fixture disposal');
        await closePromise;
        if (invalid || count !== 1) throw new Error('invalid WebSocket close observation at cleanup');
      } finally {
        try { if (concludeObserver) receiver.removeListener('conclude', concludeObserver); }
        finally {
          try { if (closeObserver) backing.removeListener('close', closeObserver); }
          finally {
            try { if (errorObserver) backing.removeListener('error', errorObserver); }
            finally { scope.disable(); }
          }
        }
      }
    }
  };
}
