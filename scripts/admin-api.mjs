export async function adminRequest(
  path,
  { method, body, env = process.env, fetchImpl = fetch, signal } = {},
) {
  const baseUrl = requiredEnv("CLAWROUTER_BASE_URL", env).replace(/\/$/, "");
  const adminToken = requiredEnv("CLAWROUTER_ADMIN_TOKEN", env);
  const accessClientId = optionalEnv("CF_ACCESS_CLIENT_ID", env);
  const accessClientSecret = optionalEnv("CF_ACCESS_CLIENT_SECRET", env);
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error(
      "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be configured together",
    );
  }
  const headers = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
  if (accessClientId && accessClientSecret) {
    headers["CF-Access-Client-Id"] = accessClientId;
    headers["CF-Access-Client-Secret"] = accessClientSecret;
  }
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal,
  });
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `admin API redirected with ${response.status}; configure CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET when Cloudflare Access protects this route`,
    );
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`admin API returned non-JSON ${response.status}: ${text}`);
  }
  if (!response.ok) {
    const detail = json?.error?.message || text || "request failed";
    throw new Error(`admin API ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return json;
}

function requiredEnv(name, env) {
  const value = optionalEnv(name, env);
  if (!value) {
    throw new Error(`${name} is required for remote key mutations`);
  }
  return value;
}

function optionalEnv(name, env) {
  return env[name]?.trim() || "";
}
