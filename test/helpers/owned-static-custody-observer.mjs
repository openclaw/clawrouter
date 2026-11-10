import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after } from 'node:test';

// Load before dynamic Worker imports. Observe the actual singleton publication;
// never call the guard, reserve capacity, reset or release its permanent claim.
const observation = globalThis.__ownedStaticCustodyFixture = { held: 0, claims: 0 };
const hook = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/worker/proxy-completion.ts')) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const anchor = 'ownedHttpStaticCharge = charge;';
  assert.equal(source.split(anchor).length - 1, 1);
  return { ...result, source: source.replace(anchor, anchor + '\n globalThis.__ownedStaticCustodyFixture.held = charge.bytes; globalThis.__ownedStaticCustodyFixture.claims++;') };
} });
export function ownedStaticHeld() {
  assert.ok(observation.claims === 0 || observation.claims === 1);
  assert.equal(observation.held, observation.claims * 65536);
  return observation.held;
}
after(() => { hook.deregister(); delete globalThis.__ownedStaticCustodyFixture; });
