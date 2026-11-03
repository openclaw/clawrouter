export function cloudflareClient(diagnostics) {
  return async (token, path, init = {}) => {
    let response;
    let body;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
      body = await response.json().catch(() => ({}));
    } catch (error) {
      diagnostics.push(`could not reach Cloudflare API: ${error.message}`);
      return { ok: false, status: 0, body: {} };
    }
    return { ok: response.ok, status: response.status, body };
  };
}

export function cloudflareError(response) {
  return response.body.errors?.[0]?.message ?? `HTTP ${response.status}`;
}
