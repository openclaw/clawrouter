// Observe trigger version identity only. Raw tail records (which may include
// headers/logs) are never printed, persisted, or returned to the controller.
export function queueObservation(record, queue, versions) {
  const version = record?.scriptVersion?.id;
  const count = record?.event?.batchSize;
  if (record?.event?.queue !== queue || !versions.includes(version) || !Number.isSafeInteger(count) || count < 0) return null;
  return { version, messages: count };
}
export async function startQueueObservation({ api, state, save, queue = 'clawrouter-usage', WebSocketImpl = WebSocket }) {
  let tail, socket, stage = 'create';
  const stop = async () => {
    socket?.close();
    if (tail) {
      const id = tail.id; tail = null;
      try { await api.cloudflare(`${api.workerPath}/tails/${id}`, { method: 'DELETE' }); }
      catch { state.queueObservationCleanup = 'tail deletion unconfirmed; service expiry remains'; save(state); }
    }
  };
  try {
    tail = await api.cloudflare(`${api.workerPath}/tails`, { method: 'POST', body: { filters: [] } });
    stage = 'validate';
    // Tail IDs are Cloudflare's 32-hex Identifier, NOT Worker version UUIDs.
    if (!/^[a-f0-9]{32}$/i.test(tail?.id ?? '') || new URL(tail.url).protocol !== 'wss:') throw new Error('invalid tail response');
    stage = 'connect';
    socket = new WebSocketImpl(tail.url, 'trace-v1');
    socket.addEventListener('message', async (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        if (text.length > 1024 * 1024) return;
        const observation = queueObservation(JSON.parse(text), queue, [state.blue, state.green]);
        if (!observation) return;
        state.queueObservations ??= [];
        const percentage = state.percentage ?? null;
        let row = state.queueObservations.find((r) => r.percentage === percentage && r.version === observation.version);
        if (!row) { row = { percentage, version: observation.version, batches: 0, messages: 0 }; state.queueObservations.push(row); }
        row.batches++; row.messages += observation.messages; save(state);
      } catch { /* Unsupported trace payloads are not evidence and must not leak. */ }
    });
    socket.addEventListener('error', () => { state.queueObservationStatus = 'stream unavailable'; save(state); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tail connect timeout')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); socket.send(JSON.stringify({ debug: false })); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('tail connect failure')); }, { once: true });
    });
    state.queueObservationStatus = 'connected; samples are observations, not a platform guarantee'; save(state);
    return stop;
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? ` HTTP ${error.status}` : '';
    state.queueObservationStatus = `unavailable at ${stage}${status}; consumer version unobserved`; save(state);
    await stop(); return async () => {};
  }
}
