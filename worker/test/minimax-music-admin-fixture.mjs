import { accessCertsResponse } from "./access-byte-fixture.mjs";
import assert from "node:assert/strict";
import { syntheticTransport } from "./minimax-search-byte-fixture.mjs";

export const musicAdmin = { auth: "cloudflare_access", email: "music-admin@example.invalid", role: "admin" };
export const musicIssuer = "https://music-admin-fixture.cloudflareaccess.com";
let keys;
export async function musicAccessFixture() {
  keys ??= crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pair = await keys, jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "music-admin-fixture" };
  const enc = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = enc({ alg: "RS256", kid: jwk.kid }) + "." + enc({ iss: musicIssuer, aud: "music-admin-fixture",
    email: musicAdmin.email, sub: "synthetic-music-admin", exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
  return { jwk, headers: { "cf-access-jwt-assertion": unsigned + "." + Buffer.from(signature).toString("base64url"), origin: "https://router.example" },
    env: { CLAWROUTER_ACCESS_TEAM_DOMAIN: musicIssuer, CLAWROUTER_ACCESS_AUD: "music-admin-fixture", CLAWROUTER_ACCESS_ADMIN_EMAILS: musicAdmin.email } };
}

export async function installMusicAdmin(t, f) {
  const access = await musicAccessFixture(); Object.assign(f.env, access.env);
  f.musicHeaders = access.headers;
  f.musicUser = (enabled = true, role = "admin") => f.authority("/users/put", { email: musicAdmin.email,
    record: { role, enabled, tenantId: "tenant", groups: [], contentRetentionDisabled: false } });
  await f.musicUser();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => new Request(input, init).url === musicIssuer + "/cdn-cgi/access/certs"
    ? Promise.resolve(accessCertsResponse({ keys: [access.jwk] }, musicIssuer + "/cdn-cgi/access/certs")) : fetch(input, init));
  // Node fake RPC responses need a known byte producer; workerd tests use the
  // actual transport and do not inherit this synthetic BYOB evidence.
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(input, init) {
    const response = await stub.fetch(input, init);
    return new URL(input).pathname === "/grant-music/authorize" ? syntheticTransport(response) : response;
  } }; };
  f.musicPut = async (body, query = "", headers = access.headers) => {
    const response = await f.call("/v1/admin/upstream-grants/policies/fixture/replicate" + query, body, { method: "PUT", headers });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
}
