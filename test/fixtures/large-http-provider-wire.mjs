// Copied beside the freshly bundled production runtime by its local proof.
// Keep the fixture address as data; never interpolate it into executable source.
const origin = new URL(process.env.LARGE_HTTP_FIXTURE_PROVIDER_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
  throw new Error('invalid_fixture_provider_origin');
const provider = new URL('/provider', origin);
const wire = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol === 'https:') {
    const headers = new Headers(init.headers);
    headers.set('x-fixture-upstream', url.href);
    return wire(provider, { ...init, headers });
  }
  return wire(input, init);
};
await import('./runtime.mjs');
