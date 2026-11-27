// Explicit --import preload for the controlled release proof, never production.
// Fixture targets are data, not interpolated JavaScript source.
const targets = JSON.parse(process.env.CLAWROUTER_RELEASE_PROOF_TARGETS ?? 'null');
if (typeof targets?.origin !== 'string' || typeof targets?.local !== 'string')
  throw new Error('Missing release proof targets');
const { origin, local } = targets;
const fixture = new URL(origin), loopback = new URL(local);
if (fixture.origin !== origin || fixture.protocol !== 'https:' ||
    !/^clawrouter-native-qualification-[0-9a-f]{12}\.fixture\.workers\.dev$/.test(fixture.hostname) ||
    loopback.origin !== local || loopback.protocol !== 'http:' ||
    loopback.hostname !== '127.0.0.1' || !loopback.port)
  throw new Error('Invalid release proof targets');

const allowed = new Set(['https://api.cloudflare.com', origin, local]);
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (!allowed.has(url.origin)) throw new Error('External egress refused');
  return original(local + url.pathname + url.search, {
    method: request.method, headers: request.headers, body: request.body,
    duplex: 'half', redirect: 'error', signal: request.signal,
  });
};
