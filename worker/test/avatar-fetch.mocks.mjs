export async function verifiedAccessSession() {
  return {
    authenticated: true,
    auth: "local",
    role: "admin",
    email: "admin@example.com",
    subject: null,
    tenantId: "default",
    groups: [],
    contentRetentionDisabled: false,
  };
}

export function publicSession(session) {
  return session;
}

export async function sessionPolicies() {
  return [];
}
