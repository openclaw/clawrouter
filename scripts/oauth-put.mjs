import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kid = args.kid;
const tenant = args.tenant;
const tokenRef = required(args["token-ref"] ?? args.provider, "--token-ref or --provider");
const kind = parseKind(args.kind ?? "oauth");
const provider = optionalValue(args, "provider");
const label = optionalValue(args, "label");
assertSingleStdinSecret(args);
const accessToken = readSecret(args, "access-token");
const credential = readSecret(args, "credential");
const refreshToken = readSecret(args, "refresh-token");
validatePrimarySecret(kind, { accessToken, credential });
if (kind === "api_key" && refreshToken) {
  throw new Error("--refresh-token-* is only supported for oauth and subscription grants");
}
const tokenType = optionalValue(args, "token-type") ?? "Bearer";
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

if (Boolean(kid) === Boolean(tenant)) {
  throw new Error("exactly one of --kid or --tenant is required");
}

const key = kid ? `oauth/${kid}/${tokenRef}` : `oauth/tenants/${tenant}/${tokenRef}`;
const now = new Date().toISOString();
const grant = {
  version: 1,
  enabled: true,
  kind,
  tokenType,
  scopes: parseList(optionalValue(args, "scopes")),
  createdAt: now,
  updatedAt: now,
};
setOptional(grant, "provider", provider);
setOptional(grant, "label", label);
setOptional(grant, "accessToken", accessToken);
setOptional(grant, "credential", credential);
setOptional(grant, "refreshToken", refreshToken);
setOptional(grant, "expiresAt", parseTimestamp(optionalValue(args, "expires-at"), "--expires-at"));
setOptional(grant, "accountId", optionalValue(args, "account-id"));
setOptional(grant, "subscription", subscriptionMetadata(args));
setOptional(grant, "refresh", refreshMetadata(args));
const grantPath = writeSecretJson(grant);

try {
  run("pnpm", [
    "exec",
    "wrangler",
    "kv",
    "key",
    "put",
    key,
    "--path",
    grantPath,
    "--binding",
    binding,
    "--config",
    config,
    ...kvTargetArgs(args),
  ]);
} finally {
  rmSync(grantPath, { force: true });
  rmSync(join(grantPath, ".."), { force: true, recursive: true });
}

console.log(`stored canonical upstream grant ${key}; secrets were not printed`);

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      continue;
    }
    const name = value.slice(2);
    if (values[i + 1] && !values[i + 1].startsWith("--")) {
      out[name] = values[i + 1];
      i += 1;
    } else {
      out[name] = true;
    }
  }
  return out;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredOption(args, name) {
  return required(optionalValue(args, name), `--${name}`);
}

function optionalValue(args, name) {
  const value = args[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`--${name} requires a value`);
  }
  return value.trim();
}

function readSecret(args, name) {
  if (args[name] !== undefined) {
    throw new Error(
      `--${name} would expose the secret in process argv; use --${name}-stdin, --${name}-env, or --${name}-file`,
    );
  }
  const envName = optionalValue(args, `${name}-env`);
  const file = optionalValue(args, `${name}-file`);
  const stdin = args[`${name}-stdin`];
  if (stdin !== undefined && stdin !== true) {
    throw new Error(`--${name}-stdin is a flag and does not accept a value`);
  }
  const sourceCount = [envName, file, stdin === true].filter(Boolean).length;
  if (sourceCount > 1) {
    throw new Error(`use only one of --${name}-stdin, --${name}-env, or --${name}-file`);
  }
  if (envName) {
    return required(process.env[envName], `env ${envName}`);
  }
  if (file) {
    return required(readFileSync(file, "utf8").trim(), `--${name}-file`);
  }
  if (stdin) {
    return required(readFileSync(0, "utf8").trim(), `stdin ${name}`);
  }
  return undefined;
}

function assertSingleStdinSecret(args) {
  const stdinSecrets = ["access-token", "credential", "refresh-token"].filter(
    (name) => args[`${name}-stdin`] !== undefined,
  );
  if (stdinSecrets.length > 1) {
    throw new Error("only one secret may be read from stdin; use env or file for other secrets");
  }
}

function validatePrimarySecret(kind, { accessToken, credential }) {
  if (accessToken && credential) {
    throw new Error("use exactly one primary secret: accessToken or credential");
  }
  if (kind === "api_key" && !credential) {
    throw new Error("api_key grants require --credential-stdin, --credential-env, or --credential-file");
  }
  if (kind === "oauth" && !accessToken) {
    throw new Error("oauth grants require --access-token-stdin, --access-token-env, or --access-token-file");
  }
  if (kind === "subscription" && !accessToken && !credential) {
    throw new Error(
      "subscription grants require an accessToken or credential supplied through stdin, env, or file",
    );
  }
}

function parseKind(value) {
  if (!["api_key", "oauth", "subscription"].includes(value)) {
    throw new Error("--kind must be api_key, oauth, or subscription");
  }
  return value;
}

function parseList(value) {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseTimestamp(value, name) {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return timestamp.toISOString();
}

function subscriptionMetadata(args) {
  const plan = optionalValue(args, "subscription-plan");
  const subject = optionalValue(args, "subscription-subject");
  if (!plan && !subject) {
    return undefined;
  }
  return compact({ plan, subject });
}

function refreshMetadata(args) {
  const tokenUrl = optionalValue(args, "refresh-token-url");
  const clientId = optionalValue(args, "refresh-client-id");
  const clientIdConfig = optionalValue(args, "refresh-client-id-config");
  const clientSecretConfig = optionalValue(args, "refresh-client-secret-config");
  const extraParams = parseStringMap(
    optionalValue(args, "refresh-extra-params-json"),
    "--refresh-extra-params-json",
  );
  if (!tokenUrl && !clientId && !clientIdConfig && !clientSecretConfig && !extraParams) {
    return undefined;
  }
  if (clientId && clientIdConfig) {
    throw new Error("use only one of --refresh-client-id or --refresh-client-id-config");
  }
  return {
    tokenUrl: required(tokenUrl, "--refresh-token-url"),
    ...(clientId
      ? { clientId }
      : { clientIdConfig: required(clientIdConfig, "--refresh-client-id or --refresh-client-id-config") }),
    ...(clientSecretConfig ? { clientSecretConfig } : {}),
    extraParams: extraParams ?? {},
  };
}

function parseStringMap(value, name) {
  if (!value) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.values(parsed).some((item) => typeof item !== "string")
  ) {
    throw new Error(`${name} must be a JSON object with string values`);
  }
  if (Object.keys(parsed).some(isSecretFieldName)) {
    throw new Error(`${name} must not contain secret fields`);
  }
  return parsed;
}

function isSecretFieldName(name) {
  return [
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "credential",
    "apiKey",
    "api_key",
    "token",
    "secret",
    "clientSecret",
    "client_secret",
    "password",
  ].includes(name);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function setOptional(target, name, value) {
  if (value !== undefined) {
    target[name] = value;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed`);
  }
}

function writeSecretJson(value) {
  const dir = mkdtempSync(join(tmpdir(), "clawrouter-oauth-"));
  const path = join(dir, "grant.json");
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  return path;
}

function kvTargetArgs(args) {
  if (args.local) {
    return ["--preview", "false"];
  }
  return ["--remote", "--preview", "false"];
}
