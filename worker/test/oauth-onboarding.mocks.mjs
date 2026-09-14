export async function authorizeAdmin() {
  return { role: "admin", email: "admin@example.com" };
}

export const verifiedAccessSession = authorizeAdmin;

export async function authorityCall(env, path, body) {
  env.calls.push({ path, body });
  return { state: env.state ?? null };
}
