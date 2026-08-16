export async function verifiedAccessSession() {
  return { role: "admin", email: "admin@example.com" };
}

export async function authorizeAdmin() {
  return { email: "admin@example.com" };
}

export async function authorityCall() {
  return {
    state: {
      state: "state-1",
      verifier: "verifier",
      actorEmail: "admin@example.com",
      grantKey: "oauth/policy/openai",
      provider: "openai",
      priority: 100,
      weight: 1,
      redirectUri: "https://console.example/v1/oauth/callback",
      expiresAtMs: Date.now() + 60_000,
    },
  };
}

export function providerById(id) {
  if (id !== "openai") return null;
  return {
    id: "openai",
    display_name: "OpenAI",
    auth: {
      authorization: {
        tokenUrl: "https://token.example/oauth/token",
        clientId: "client",
        clientIdConfig: null,
        clientSecretConfig: null,
        scopes: ["openid"],
        extraTokenParams: {},
        grantKind: "oauth",
        accountIdJsonPointer: null,
        subscriptionPlanJsonPointer: null,
      },
    },
  };
}

export async function syncGrantPoolIndex() {}
