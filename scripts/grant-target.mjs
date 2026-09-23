export function grantTarget(args) {
  const env = localAdminEnvironment(args);
  if (Boolean(args.kid) === Boolean(args.tenant)) throw new Error("exactly one of --kid or --tenant is required");
  const scope = args.kid ? "policies" : "tenants";
  const scopeId = required(args.kid ?? args.tenant, args.kid ? "--kid" : "--tenant");
  const tokenRef = required(args["token-ref"] ?? args.provider, "--token-ref or --provider");
  return {
    path: `/v1/admin/upstream-grants/${scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(tokenRef)}`,
    key: scope === "policies" ? `oauth/${scopeId}/${tokenRef}` : `oauth/tenants/${scopeId}/${tokenRef}`,
    tokenRef,
    env,
  };
}

export function localAdminEnvironment(args, env = process.env) {
  if (args.binding !== undefined || args.config !== undefined) {
    throw new Error("key and grant mutations use the admin API; replace --binding/--config with CLAWROUTER_BASE_URL and CLAWROUTER_ADMIN_TOKEN");
  }
  if (args.local !== undefined && args.local !== true) throw new Error("--local is a flag and does not accept a value");
  if (args.local) {
    const baseUrl = env.CLAWROUTER_BASE_URL?.trim() || "http://127.0.0.1:8787";
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("--local requires a loopback CLAWROUTER_BASE_URL; start the local Worker and configure its admin token");
    }
    return { ...env, CLAWROUTER_BASE_URL: baseUrl };
  }
  return env;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
