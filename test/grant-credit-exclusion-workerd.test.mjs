import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkerdFixture } from './helpers/workerd.mjs';

test('real workerd rotates a depleted sticky grant before SSE delivery and excludes a fully depleted pool', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'clawrouter-credit-'));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, `
      import handler from './worker/index.ts';
      export * from './worker/index.ts';
      export default handler;
    `, String.raw`
      const depleted = new Set(); let calls = 0;
      export default { async fetch(request) {
        calls++;
        const key = request.headers.get('x-api-key');
        const body = await request.json();
        if (body.messages[0].content === 'deplete' && !depleted.size || body.messages[0].content === 'deplete-all') depleted.add(key);
        if (depleted.has(key)) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, { status: 400 });
        return new Response('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: key, usage: { input_tokens: 1 } } }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-fixture-calls': String(calls) } });
      } };
    `, { hotCache: true });
    const kv = await mf.getKVNamespace('POLICY_KV', 'router');
    const secret = 'synthetic-credit-secret';
    await kv.put('policies/fixture', JSON.stringify({ enabled: true, generation: 'g1', providers: ['anthropic'], tenantId: 'fixture', monthlyBudgetMicros: null, retainRequestContent: false, grantRouting: { stickiness: 'session' } }));
    await kv.put('credentials/fixture', JSON.stringify({ enabled: true, secretSha256: createHash('sha256').update(secret).digest('hex'), policyId: 'fixture', policyGeneration: 'g1' }));
    for (const [key, credential] of [['oauth/fixture/anthropic', 'synthetic-policy'], ['oauth/tenants/fixture/anthropic', 'synthetic-tenant']]) await kv.put(key, JSON.stringify({ provider: 'anthropic', kind: 'api_key', enabled: true, credential, updatedAt: '2026-01-01T00:00:00Z' }));
    await kv.put('connections/anthropic', JSON.stringify({ providerId: 'anthropic', enabled: true }));
    const origin = await mf.ready;
    const send = async content => {
      const response = await fetch(new URL('/v1/messages', origin), { method: 'POST', headers: { authorization: `Bearer clawrouter-live-fixture-${secret}`, 'content-type': 'application/json', 'x-clawrouter-session-id': 'synthetic-session' },
        body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(10_000) });
      return { response, body: await response.text() };
    };
    const first = await send('healthy');
    assert.equal(first.response.status, 200);
    const initial = JSON.parse(first.body.split('\ndata: ')[1].split('\n')[0]).message.id;
    const rotated = await send('deplete');
    assert.equal(rotated.response.status, 200);
    assert.equal(rotated.response.headers.get('x-clawrouter-grant-failover'), '1');
    assert.ok(!rotated.body.includes(initial), 'only alternate SSE bytes are delivered');
    const warm = await send('healthy');
    assert.equal(warm.response.status, 200);
    assert.equal(warm.response.headers.get('x-fixture-calls'), '4');
    const failed = await send('deplete-all');
    assert.equal(failed.response.status, 400);
    assert.equal(failed.response.headers.get('x-clawrouter-grant-failover'), null);
    const blocked = await send('healthy');
    assert.equal(blocked.response.status, 429);
    assert.match(blocked.body, /no available scoped upstream grant/);
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 290);
    assert.ok(['synthetic-policy', 'synthetic-tenant'].includes(initial));
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
