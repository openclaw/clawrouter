import { Buffer } from "node:buffer";

const MAX_RESPONSE_BYTES = 128 * 1024;
// RFC 9110 media-type parameters: reject HTML, lists and malformed JSON lookalikes.
const JSON_MEDIA_TYPE = /^application\/json(?:[ \t]*;[ \t]*(?:[!#$%&'*+.^_`|~\w-]+=(?:[!#$%&'*+.^_`|~\w-]+|"(?:[\t !#-\[\]-~\x80-\xff]|\\[\t -~\x80-\xff])*"))?)*[ \t]*$/i;

export async function adminRequest(
  path,
  { method, body, env = process.env, fetchImpl = fetch, signal, responseMode = "json" } = {},
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
    accept: "application/json",
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
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(
      `admin API redirected with ${response.status}; configure CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET when Cloudflare Access protects this route`,
    );
  }
  if (response.ok && responseMode === "ack") {
    // These mutation handlers commit before sending success headers. Unused
    // response delivery or cancellation cleanup must not change that outcome.
    void response.body?.cancel().catch(() => undefined);
    if (!(response.status === 204 && response.body === null) && !JSON_MEDIA_TYPE.test(response.headers.get("content-type") ?? "")) {
      throw new Error(`admin API returned non-JSON ${response.status}`);
    }
    return;
  }
  const text = await boundedResponseText(response);
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`admin API returned non-JSON ${response.status}`);
  }
  if (!response.ok) {
    const detail = typeof json?.error?.message === "string" ? json.error.message : "request failed";
    throw new Error(`admin API ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return json;
}

async function boundedResponseText(response) {
  // Admin responses can contain one-time secrets. Bound reads and never use the
  // raw body as an error diagnostic, including malformed or oversized responses.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("admin API response was too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
