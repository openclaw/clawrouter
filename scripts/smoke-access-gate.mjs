export function assertAccessGateResponse(response, contentType, body, name) {
  if (contentType.includes("application/json")) {
    let code = null;
    try {
      code = JSON.parse(body)?.error?.code ?? null;
    } catch {}
    throw new Error(
      `${name} reached ClawRouter's ${code ?? "JSON"} fallback; Cloudflare Access is not protecting the path`,
    );
  }
  if (response.ok && contentType.includes("text/html") && body.includes("ClawRouter")) {
    throw new Error(`${name} returned the ClawRouter console without Cloudflare Access`);
  }
  if (response.status >= 300 && response.status < 400) {
    return;
  }
  if ((response.status === 401 || response.status === 403) && !body.includes("ClawRouter")) {
    return;
  }
  throw new Error(`${name} returned ${response.status}, expected Cloudflare Access challenge`);
}
