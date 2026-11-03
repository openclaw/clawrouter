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

export async function probeCloudflareKvWrite(request, token, path) {
  const put = await request(token, path, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "ok",
  });
  if (!put.ok || put.body.success === false) {
    return { status: put.status, error: `CLOUDFLARE_API_TOKEN cannot write POLICY_KV: ${cloudflareError(put)}` };
  }
  const deleted = await request(token, path, { method: "DELETE" });
  if (!deleted.ok || deleted.body.success === false) {
    return { status: deleted.status, error: `CLOUDFLARE_API_TOKEN wrote POLICY_KV but could not delete probe key: ${cloudflareError(deleted)}` };
  }
  return null;
}
