// Auth declarations and cross-field checks after provider manifest schema validation.
// Runtime credential resolution, refresh, and transport execution have separate owners.

export function compileProviderAuth(manifest) {
  return {
    schemes: (manifest.auth.schemes ?? []).map(normalizeAuthScheme),
    authorization: normalizeAuthorization(manifest.auth.authorization),
    refresh: normalizeRefresh(manifest.auth.refresh),
    grantTransports: Object.fromEntries(Object.entries(manifest.auth.grantTransports ?? {}).map(([kind, transport]) => [kind, normalizeGrantTransport(transport)])),
  };
}

export function validateGrantTransports(manifest) {
  const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  for (const [kind, transport] of Object.entries(manifest.auth.grantTransports ?? {})) {
    if (!new Set(["api_key", "oauth", "subscription"]).has(kind)) throw new Error(`provider ${manifest.id} grant transport ${kind} has an invalid grant kind`);
    for (const name of [...Object.keys(transport.headers ?? {}), ...Object.keys(transport.appendHeaders ?? {})]) if (!headerName.test(name)) throw new Error(`provider ${manifest.id} grant transport ${kind} has an invalid header`);
    if (transport.allowedEndpoints?.some((id) => !Object.hasOwn(manifest.endpoints, id))) throw new Error(`provider ${manifest.id} grant transport ${kind} allowedEndpoints must reference unique existing endpoints`);
    const warm = transport.maintenance?.keepWarm;
    if (warm) {
      if (!Object.hasOwn(manifest.endpoints, warm.endpoint)) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm references missing endpoint ${warm.endpoint}`);
      const endpoint = manifest.endpoints[warm.endpoint];
      if ((endpoint.method ?? "POST").toUpperCase() !== "POST" || (endpoint.pathParams ?? []).length) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm requires a POST endpoint without path parameters`);
      if (JSON.stringify(warm.body).length > 16 * 1024) throw new Error(`provider ${manifest.id} grant transport ${kind} keep-warm body is too large`);
    }
    if (transport.maintenance?.quotaPoll && !(manifest.quota?.probes ?? []).some((probe) => probe.grantKinds?.includes(kind))) throw new Error(`provider ${manifest.id} grant transport ${kind} quota polling requires a matching quota probe`);
  }
}

export function authSchemeId(scheme) {
  if (scheme.type === "bearer") return `bearer:${scheme.secretKind}${scheme.required ? "" : ":optional"}`;
  if (scheme.type === "api_key" || scheme.type === "query_api_key") return `${scheme.type}:${scheme.secretKind}`;
  if (scheme.type === "oauth") return scheme.provider ? `oauth:${scheme.provider}` : "oauth";
  if (scheme.type === "sig_v4") return `sigv4:${scheme.service}`;
  return scheme.type;
}

function normalizeAuthScheme(scheme) {
  if (scheme.type === "bearer") return { ...scheme, required: scheme.required ?? true };
  if (scheme.type === "oauth") return {
    ...scheme,
    provider: scheme.provider ?? null,
    tokenRef: scheme.tokenRef ?? null,
  };
  if (scheme.type === "sig_v4") return { ...scheme, regionParam: scheme.regionParam ?? null };
  return scheme;
}

function normalizeAuthorization(value) {
  if (!value) return null;
  return {
    ...value,
    clientId: value.clientId ?? null,
    clientIdConfig: value.clientIdConfig ?? null,
    clientSecretConfig: value.clientSecretConfig ?? null,
    grantKind: value.grantKind ?? "oauth",
    extraAuthorizeParams: value.extraAuthorizeParams ?? {},
    extraTokenParams: value.extraTokenParams ?? {},
    accountIdJsonPointer: value.accountIdJsonPointer ?? null,
    subscriptionPlanJsonPointer: value.subscriptionPlanJsonPointer ?? null,
  };
}

function normalizeRefresh(value) {
  if (!value) return null;
  return {
    ...value,
    clientId: value.clientId ?? null,
    clientIdConfig: value.clientIdConfig ?? null,
    clientSecretConfig: value.clientSecretConfig ?? null,
    requestFormat: value.requestFormat ?? "form",
    extraParams: value.extraParams ?? {},
  };
}

function normalizeGrantTransport(value) {
  return {
    baseUrl: value.baseUrl ?? null,
    auth: value.auth ?? null,
    endpointPaths: value.endpointPaths ?? {},
    ...(value.allowedEndpoints ? { allowedEndpoints: value.allowedEndpoints } : {}),
    headers: value.headers ?? {},
    appendHeaders: value.appendHeaders ?? {},
    requestTransforms: { prependSystem: value.requestTransforms?.prependSystem ?? [] },
    maintenance: {
      quotaPoll: value.maintenance?.quotaPoll ?? null,
      keepWarm: value.maintenance?.keepWarm ? { ...value.maintenance.keepWarm, defaultEnabled: value.maintenance.keepWarm.defaultEnabled === true } : null,
    },
  };
}
