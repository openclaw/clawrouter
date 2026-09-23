import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { localAdminEnvironment } from "./grant-target.mjs";
import { parseArgs } from "./cli-args.mjs";
import { adminRequest } from "./admin-api.mjs";
import { deploymentTarget } from "./deployment-profile.mjs";

const args = parseArgs(process.argv.slice(2));
const deployment = deploymentTarget();
const env = localAdminEnvironment(args);
const kid = required(args.kid, "--kid");
const secret = readSecret(args);
const allProviders = args["all-providers"] === true;
if (args["all-providers"] !== undefined && !allProviders) {
  throw new Error("--all-providers is a flag and does not accept a value");
}
if (args.providers && allProviders) {
  throw new Error("--providers and --all-providers are mutually exclusive");
}
const providers =
  typeof args.providers === "string"
    ? [...new Set(args.providers.split(",").map((provider) => provider.trim()).filter(Boolean))]
    : [];
if (!allProviders && providers.length === 0) {
  throw new Error("--providers or --all-providers is required");
}
const enabled = args.disabled ? false : true;
const tenantId = args.tenant ?? deployment.accessDefaultTenant;
const monthlyBudgetMicros = args["monthly-budget-micros"]
  ? parseNonNegativeInteger(args["monthly-budget-micros"], "--monthly-budget-micros")
  : undefined;
const requestCostMicros = args["request-cost-micros"]
  ? parseNonNegativeInteger(args["request-cost-micros"], "--request-cost-micros")
  : undefined;
const request = {
  enabled,
  providers,
  allProviders,
  tenantId,
  secretSha256: createHash("sha256").update(secret).digest("hex"),
};
if (monthlyBudgetMicros !== undefined) {
  request.monthlyBudgetMicros = monthlyBudgetMicros;
}
if (requestCostMicros !== undefined) {
  request.requestCostMicros = requestCostMicros;
}

await adminRequest(`/v1/admin/keys/${encodeURIComponent(kid)}`, {
  method: "PUT",
  body: request,
  env,
});
console.log(
  `stored authoritative access policy and proxy credential for ${kid}; secret was not printed`,
);

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readSecret(args) {
  if (args.secret) {
    throw new Error(
      "--secret would expose the proxy secret in process argv; use --secret-stdin, --secret-env, or --secret-file",
    );
  }
  if (args["secret-env"]) {
    return required(process.env[args["secret-env"]], `env ${args["secret-env"]}`);
  }
  if (args["secret-file"]) {
    return required(readFileSync(args["secret-file"], "utf8").trim(), "--secret-file");
  }
  if (args["secret-stdin"]) {
    return required(readFileSync(0, "utf8").trim(), "stdin secret");
  }
  throw new Error("--secret-stdin, --secret-env, or --secret-file is required");
}

function parseNonNegativeInteger(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be less than or equal to Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}
