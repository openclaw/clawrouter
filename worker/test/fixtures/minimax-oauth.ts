import type { MiniMaxDeviceSession, MiniMaxOAuthCredential } from "../../provider-minimax-oauth.ts";

export const miniMaxFixtureNow = 2_000_000_000_000;
export const miniMaxFixtureSession = {
  region: "global", ownerBinding: "fixture-principal:grant-v1",
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  state: "fixture-state-abcdefghijklmnop", requestId: "fixture-request-0001",
} satisfies MiniMaxDeviceSession;
export const miniMaxFixtureCredential = {
  kind: "oauth", region: "global", ownerBinding: miniMaxFixtureSession.ownerBinding,
  access: "synthetic-access", refresh: "synthetic-refresh", expiresAt: miniMaxFixtureNow + 3_600_000,
  tokenEndpoint: "https://account.minimax.io/oauth2/token",
  resource: { region: "global", origin: "https://api.minimax.io", anthropicBaseUrl: "https://api.minimax.io/anthropic" },
} satisfies MiniMaxOAuthCredential;
