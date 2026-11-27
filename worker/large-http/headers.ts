// Preserve router inputs across the runtime boundary. The real router owns
// provider-header allowlists, correlation validation, selection and transforms.
export function requestTarget(value: string): string {
  const url = new URL(value);
  return url.pathname + url.search;
}

export function routerHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  const nominated = (headers.get('connection') ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const name of [...nominated, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith('x-canary-') || name === 'x-container-token' || name === 'x-payload-canary-token' || name.startsWith('x-large-http-')) headers.delete(name);
  return headers;
}

export function largeCreatePath(path: string): boolean {
  return /^\/v1\/(?:(?:native\/openai\/v1\/)?responses(?:\/compact)?|proxy\/openai\/responses(?:_compact)?)$/.test(path);
}
