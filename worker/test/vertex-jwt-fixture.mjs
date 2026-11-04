// Generated only during tests. No vendor key, service account or token is used.
export async function syntheticVertexKey() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encoded = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  return { publicKey: keys.publicKey, pem: `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----` };
}
export const signingBinding = patch => ({ version: "clawrouter.vertex-anthropic.v1", source: "service_account",
  project: "fixture-project", location: "us-east5", clientEmail: "synthetic@fixture-project.iam.gserviceaccount.com", keyId: "synthetic-key", ...patch });
export const tokenBody = patch => ({ access_token: "synthetic-jwt-access", token_type: "Bearer", expires_in: 3600,
  scope: "https://www.googleapis.com/auth/cloud-platform", ...patch });
export async function bounded(pending, name) {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + " did not settle")), 5000); })]); }
  finally { clearTimeout(timer); }
}
