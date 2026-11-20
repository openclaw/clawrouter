// Static authentication declarations. Credential storage and execution belong to the host.
export type GrantTransportAuth =
  | { type: "bearer"; header: string; format: string }
  | { type: "api_key"; header: string }
  | { type: "query_api_key"; param: string };
export interface CompiledGrantTransport {
  baseUrl: string | null;
  auth: GrantTransportAuth | null;
  endpointPaths: Record<string, string>;
  allowedEndpoints?: string[];
  headers: Record<string, string>;
  appendHeaders: Record<string, string>;
  requestTransforms: { prependSystem: Array<{ type: "text"; text: string }> };
  maintenance: {
    quotaPoll: { normalIntervalSeconds: number; urgentIntervalSeconds: number; exhaustedIntervalSeconds: number; urgentRemainingPercent: number } | null;
    keepWarm: { defaultEnabled: boolean; intervalSeconds: number; endpoint: string; body: Record<string, unknown> } | null;
  };
}

export type AuthScheme =
  | { type: "bearer"; header: string; format: string; secretKind: string; required: boolean }
  | { type: "api_key"; header: string; secretKind: string }
  | { type: "query_api_key"; param: string; secretKind: string }
  | { type: "oauth"; provider: string | null; scopes: string[]; tokenRef: string | null }
  | { type: "sig_v4"; service: string; regionParam: string | null }
  | { type: "cloudflare_binding" };

export interface AuthorizationConfig { authorizeUrl: string; tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; scopes: string[]; grantKind: string; extraAuthorizeParams: Record<string, string>; extraTokenParams: Record<string, string>; accountIdJsonPointer: string | null; subscriptionPlanJsonPointer: string | null }
export interface RefreshConfig { tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; requestFormat: "form" | "json"; extraParams: Record<string, string> }
