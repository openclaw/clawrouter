import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  assertDeploymentMutation,
  deploymentTarget,
  githubScopedName,
  githubScopeArgs,
} from "./deployment-profile.mjs";

const args = parseArgs(process.argv.slice(2));
const deployment = deploymentTarget();

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const dryRun = Boolean(args["dry-run"]);
if (!dryRun) assertDeploymentMutation(deployment);
const host =
  process.env.CLAWROUTER_ACCESS_DOMAIN?.trim() ||
  hostFromBaseUrl(process.env.CLAWROUTER_BASE_URL) ||
  deployment.routeHostname;
const appDomains = accessDestinations(host);
const appName = deployment.accessAppName;
const policyName =
  deployment.accessPolicyName;
const servicePolicyName =
  deployment.accessServicePolicyName;
const sessionDuration =
  process.env.CLAWROUTER_ACCESS_SESSION_DURATION?.trim() || "24h";
const adminEmails = csv(process.env.CLAWROUTER_ACCESS_ADMIN_EMAILS);
const adminDomains = csv(process.env.CLAWROUTER_ACCESS_ADMIN_DOMAINS);
const accessAllowedEmails = csv(process.env.CLAWROUTER_ACCESS_ALLOWED_EMAILS);
const accessAllowedDomains = csv(process.env.CLAWROUTER_ACCESS_ALLOWED_DOMAINS);
const githubOrganizations = csv(process.env.CLAWROUTER_ACCESS_GITHUB_ORGS);
const allowedEmails =
  accessAllowedEmails.length > 0
    ? accessAllowedEmails
    : githubOrganizations.length > 0
      ? []
      : adminEmails;
const allowedDomains =
  accessAllowedDomains.length > 0
    ? accessAllowedDomains
    : githubOrganizations.length > 0
      ? []
      : adminDomains;
const serviceTokenIds = csv(process.env.CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS);
const allowedIdps = csv(process.env.CLAWROUTER_ACCESS_IDP_IDS);
const configuredGithubIdpId =
  process.env.CLAWROUTER_ACCESS_GITHUB_IDP_ID?.trim() ||
  (allowedIdps.length === 1 ? allowedIdps[0] : "");
const defaultTenant =
  deployment.accessDefaultTenant;
const repo = process.env.CLAWROUTER_GITHUB_REPO?.trim() || "openclaw/clawrouter";
const setGitHubVars = Boolean(args["set-github-vars"]);
const writeGitHubEnv = Boolean(args["write-github-env"]);
const keepExtraPolicies = process.env.CLAWROUTER_ACCESS_KEEP_EXTRA_POLICIES === "1";

const serviceInclude = serviceTokenIds.map((tokenId) => ({
  service_token: { token_id: tokenId },
}));

if (
  allowedEmails.length === 0 &&
  allowedDomains.length === 0 &&
  githubOrganizations.length === 0 &&
  process.env.CLAWROUTER_ACCESS_ALLOW_EVERYONE !== "1" &&
  serviceInclude.length === 0
) {
  throw new Error(
    [
      "refusing to create an Access policy with no include rules",
      "set CLAWROUTER_ACCESS_ALLOWED_EMAILS, CLAWROUTER_ACCESS_ALLOWED_DOMAINS,",
      "CLAWROUTER_ACCESS_GITHUB_ORGS, CLAWROUTER_ACCESS_SERVICE_TOKEN_IDS,",
      "or CLAWROUTER_ACCESS_ALLOW_EVERYONE=1",
    ].join(" "),
  );
}

if (!dryRun && !token) {
  throw new Error("CLOUDFLARE_API_TOKEN is required unless --dry-run is set");
}

const githubIdpId =
  githubOrganizations.length === 0
    ? ""
    : configuredGithubIdpId ||
      (dryRun ? "<github-identity-provider-id>" : await githubIdentityProviderId());
const effectiveAllowedIdps =
  allowedIdps.length > 0 ? allowedIdps : githubIdpId ? [githubIdpId] : [];
const requestedAutoRedirect = process.env.CLAWROUTER_ACCESS_AUTO_REDIRECT?.trim();
if (requestedAutoRedirect === "1" && effectiveAllowedIdps.length !== 1) {
  throw new Error(
    "CLAWROUTER_ACCESS_AUTO_REDIRECT=1 requires exactly one effective identity provider",
  );
}
const autoRedirect =
  requestedAutoRedirect === "1" ||
  (requestedAutoRedirect !== "0" && effectiveAllowedIdps.length === 1);
const humanInclude = buildHumanPolicyInclude({
  allowedEmails,
  allowedDomains,
  githubOrganizations,
  githubIdpId,
  allowEveryone: process.env.CLAWROUTER_ACCESS_ALLOW_EVERYONE === "1",
});

const appPayload = {
  name: appName,
  type: "self_hosted",
  domain: appDomains[0],
  destinations: appDomains.map((uri) => ({ type: "public", uri })),
  session_duration: sessionDuration,
  app_launcher_visible: false,
  auto_redirect_to_identity: autoRedirect,
};
if (effectiveAllowedIdps.length > 0) {
  appPayload.allowed_idps = effectiveAllowedIdps;
}

const policyPayloads = [
  {
    name: policyName,
    decision: "allow",
    precedence: 1,
    include: humanInclude,
  },
  {
    name: servicePolicyName,
    decision: "non_identity",
    precedence: 2,
    include: serviceInclude,
  },
];

if (dryRun) {
  printPlan({
    app: appPayload,
    policies: policyPayloads,
    teamDomain: process.env.CLAWROUTER_ACCESS_TEAM_DOMAIN?.trim() || null,
    aud: process.env.CLAWROUTER_ACCESS_AUD?.trim() || null,
    created: false,
    updated: false,
  });
  process.exit(0);
}

const organization = await getAccessOrganization();
const teamDomain =
  process.env.CLAWROUTER_ACCESS_TEAM_DOMAIN?.trim() ||
  accessTeamDomain(organization);

if (!teamDomain) {
  throw new Error(
    "could not resolve Cloudflare Access team domain; set CLAWROUTER_ACCESS_TEAM_DOMAIN",
  );
}

let created = false;
let updated = false;
let app = await findAccessApplication(appName, host, appDomains);
let policies = [];
if (app) {
  policies = await listAccessPolicies(app.id);
  guardExtraPolicies(policies, policyPayloads);
  app = await request(
    "PUT",
    `/accounts/${accountId}/access/apps/${app.id}`,
    { ...appPayload, id: app.id },
  );
  updated = true;
} else {
  app = await request("POST", `/accounts/${accountId}/access/apps`, appPayload);
  created = true;
}

for (const policyPayload of policyPayloads) {
  const existingPolicy = policies.find((policy) => policy.name === policyPayload.name);
  if (policyPayload.include.length === 0) {
    if (existingPolicy) {
      await request(
        "DELETE",
        `/accounts/${accountId}/access/apps/${app.id}/policies/${existingPolicy.id}`,
      );
      updated = true;
    }
    continue;
  }
  if (existingPolicy) {
    await request(
      "PUT",
      `/accounts/${accountId}/access/apps/${app.id}/policies/${existingPolicy.id}`,
      { ...policyPayload, id: existingPolicy.id },
    );
    updated = true;
  } else {
    await request(
      "POST",
      `/accounts/${accountId}/access/apps/${app.id}/policies`,
      policyPayload,
    );
    created = true;
  }
}

const aud = accessAudience(app);
if (!aud) {
  throw new Error(
    "Cloudflare created the Access application but did not return an audience tag",
  );
}

if (setGitHubVars) {
  syncGitHubVariable(repo, githubScopedName(deployment, "CLAWROUTER_ACCESS_TEAM_DOMAIN"), teamDomain);
  syncGitHubVariable(repo, githubScopedName(deployment, "CLAWROUTER_ACCESS_AUD"), aud);
  syncGitHubVariable(repo, githubScopedName(deployment, "CLAWROUTER_ACCESS_DEFAULT_TENANT"), defaultTenant);
  syncGitHubVariable(repo, githubScopedName(deployment, "CLAWROUTER_ACCESS_ADMIN_EMAILS"), adminEmails.join(","));
  syncGitHubVariable(repo, githubScopedName(deployment, "CLAWROUTER_ACCESS_ADMIN_DOMAINS"), adminDomains.join(","));
}

if (writeGitHubEnv) {
  writeGitHubEnvironment({
    CLAWROUTER_ACCESS_TEAM_DOMAIN: teamDomain,
    CLAWROUTER_ACCESS_AUD: aud,
    CLAWROUTER_ACCESS_DEFAULT_TENANT: defaultTenant,
    CLAWROUTER_ACCESS_ADMIN_EMAILS: adminEmails.join(","),
    CLAWROUTER_ACCESS_ADMIN_DOMAINS: adminDomains.join(","),
  });
}

printPlan({
  app: { ...appPayload, id: app.id },
  policies: policyPayloads,
  teamDomain,
  aud,
  created,
  updated,
});

async function getAccessOrganization() {
  try {
    return await request("GET", `/accounts/${accountId}/access/organizations`);
  } catch (error) {
    if (process.env.CLAWROUTER_ACCESS_TEAM_DOMAIN) {
      return null;
    }
    throw error;
  }
}

async function githubIdentityProviderId() {
  const providers = asArray(
    await request("GET", `/accounts/${accountId}/access/identity_providers`),
  );
  const githubProviders = providers.filter(
    (provider) =>
      provider.type === "github" &&
      (allowedIdps.length === 0 || allowedIdps.includes(provider.id)),
  );
  if (githubProviders.length !== 1) {
    throw new Error(
      [
        `expected exactly one GitHub identity provider, found ${githubProviders.length}`,
        "set CLAWROUTER_ACCESS_GITHUB_IDP_ID explicitly when the account has multiple providers",
      ].join("; "),
    );
  }
  return githubProviders[0].id;
}

async function findAccessApplication(targetName, targetHost, targetDomains) {
  const apps = asArray(await request("GET", `/accounts/${accountId}/access/apps?per_page=100`));
  return (
    apps.find((app) => app.name === targetName) ||
    apps.find((app) => destinationUris(app).some((uri) => targetDomains.includes(uri))) ||
    apps.find((app) => targetDomains.includes(app.domain)) ||
    apps.find((app) => app.domain === targetHost) ||
    null
  );
}

async function listAccessPolicies(appId) {
  return asArray(
    await request("GET", `/accounts/${accountId}/access/apps/${appId}/policies?per_page=100`),
  );
}

function guardExtraPolicies(policies, managedPolicies) {
  const managedPolicyNames = new Set(managedPolicies.map((policy) => policy.name));
  const extraPolicies = policies.filter((policy) => !managedPolicyNames.has(policy.name));
  if (extraPolicies.length === 0 || keepExtraPolicies) {
    return;
  }
  throw new Error(
    [
      "Access application has unmanaged policies:",
      extraPolicies.map((policy) => `${policy.name}(${policy.decision || "unknown"})`).join(", "),
      "Set CLAWROUTER_ACCESS_KEEP_EXTRA_POLICIES=1 to keep them intentionally,",
      "or remove them before rerunning so provisioning converges to the requested allowlist.",
    ].join(" "),
  );
}

async function request(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare API returned non-JSON ${response.status}: ${text}`);
  }
  if (!response.ok || json.success === false) {
    const details = asArray(json.errors)
      .map((error) => `${error.code ?? "error"} ${error.message ?? ""}`.trim())
      .filter(Boolean)
      .join("; ");
    const hint =
      response.status === 403 && path.includes("/access/")
        ? " Provide a Cloudflare API token or session with Zero Trust Access application and policy permissions."
        : "";
    throw new Error(
      `Cloudflare API ${method} ${path} failed (${response.status})${details ? `: ${details}` : ""}.${hint}`,
    );
  }
  return json.result;
}

function buildHumanPolicyInclude({
  allowedEmails: emails,
  allowedDomains: domains,
  githubOrganizations: organizations,
  githubIdpId: identityProviderId,
  allowEveryone,
}) {
  const rules = [];
  for (const email of emails) {
    rules.push({ email: { email } });
  }
  for (const domainValue of domains) {
    rules.push({ email_domain: { domain: domainValue } });
  }
  for (const subject of organizations) {
    rules.push(githubOrganizationRule(subject, identityProviderId));
  }
  if (allowEveryone) {
    rules.push({ everyone: {} });
  }
  return rules;
}

function githubOrganizationRule(subject, identityProviderId) {
  const parts = subject.split("/");
  if (
    !identityProviderId ||
    parts.length > 2 ||
    parts.some((part) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(part))
  ) {
    throw new Error(
      `invalid GitHub organization rule ${JSON.stringify(subject)}; expected org or org/team`,
    );
  }
  const [name, team] = parts;
  return {
    "github-organization": {
      identity_provider_id: identityProviderId,
      name,
      ...(team ? { team } : {}),
    },
  };
}

function accessTeamDomain(organization) {
  const org = Array.isArray(organization) ? organization[0] : organization;
  const raw =
    org?.auth_domain ||
    org?.team_domain ||
    org?.login_domain ||
    org?.name ||
    "";
  const value = String(raw).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!value) {
    return "";
  }
  return value.includes(".") ? value : `${value}.cloudflareaccess.com`;
}

function accessAudience(app) {
  return app?.aud || app?.aud_tag || app?.audience_tag || "";
}

function hostFromBaseUrl(value) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function accessDestinations(targetHost) {
  return (csv(process.env.CLAWROUTER_ACCESS_PATHS).length > 0
    ? csv(process.env.CLAWROUTER_ACCESS_PATHS)
    : defaultAccessPaths()
  ).map((path) => `${targetHost}${normalizeAccessPath(path)}`);
}

function destinationUris(app) {
  const destinations = asArray(app?.destinations)
    .map((destination) => destination?.uri)
    .filter(Boolean);
  return destinations.length > 0 ? destinations : asArray(app?.self_hosted_domains);
}

function defaultAccessPaths() {
  return [
    "/dashboard/*",
    "/v1/session*",
    "/v1/playground/*",
    "/v1/admin/*",
    "/v1/oauth/callback",
  ];
}

function normalizeAccessPath(value) {
  const path = value.trim();
  if (!path || path === "/") {
    throw new Error(
      "do not protect / with Cloudflare Access on the API hostname; root redirects to /dashboard, and /dashboard is Access-protected",
    );
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function csv(value) {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.result)) {
    return value.result;
  }
  return [];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = true;
    }
  }
  return parsed;
}

function printPlan({ app, policies, teamDomain, aud, created, updated }) {
  console.log("Cloudflare Access plan:");
  console.log(`environment=${deployment.environment}`);
  console.log(`host=${host}`);
  console.log(`destinations=${app.destinations.map((destination) => destination.uri).join(",")}`);
  console.log(`app=${app.name}${app.id ? ` (${app.id})` : ""}`);
  for (const policy of policies.filter((entry) => entry.include.length > 0)) {
    console.log(`policy=${policy.name} decision=${policy.decision}`);
  }
  if (githubOrganizations.length > 0) {
    console.log(`githubOrganizations=${githubOrganizations.join(",")}`);
    console.log(
      `githubIdentityProviderSource=${configuredGithubIdpId ? "configured" : "discovered"}`,
    );
  }
  console.log(
    `humanIncludeKinds=${[
      ...new Set(
        policies
          .filter((entry) => entry.decision === "allow")
          .flatMap((entry) => entry.include.flatMap((rule) => Object.keys(rule))),
      ),
    ].join(",")}`,
  );
  console.log(`created=${created}`);
  console.log(`updated=${updated}`);
  console.log(`teamDomain=${teamDomain || "<pending>"}`);
  console.log(`aud=${aud || "<pending>"}`);
  console.log("");
  console.log("Deploy vars:");
  console.log(`CLAWROUTER_ACCESS_TEAM_DOMAIN=${teamDomain || "<team>.cloudflareaccess.com"}`);
  console.log(`CLAWROUTER_ACCESS_AUD=${aud || "<access app audience tag>"}`);
  console.log(`CLAWROUTER_ACCESS_DEFAULT_TENANT=${defaultTenant}`);
  if (adminEmails.length > 0) {
    console.log(`CLAWROUTER_ACCESS_ADMIN_EMAILS=${adminEmails.join(",")}`);
  }
  if (adminDomains.length > 0) {
    console.log(`CLAWROUTER_ACCESS_ADMIN_DOMAINS=${adminDomains.join(",")}`);
  }
  console.log("");
  console.log("Expected live root check after redeploy:");
  console.log(`curl -sS -D - -o /dev/null https://${host}/`);
  console.log("Root should 302 to /dashboard, /dashboard should 302 to /dashboard/home, and Cloudflare Access should challenge console, session usage, admin, playground, and OAuth callback paths.");
}

function syncGitHubVariable(repoName, name, value) {
  const cli = process.env.CLAWROUTER_GITHUB_CLI || "ghx";
  const scope = githubScopeArgs(deployment);
  const command = value
    ? ["variable", "set", name, "--repo", repoName, ...scope, "--body", value]
    : ["variable", "delete", name, "--repo", repoName, ...scope];
  const result = spawnSync(cli, command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = result.stderr || result.stdout || `${cli} ${command.join(" ")} failed`;
    if (!value && /not found|not exist|could not resolve/i.test(output)) {
      return;
    }
    throw new Error(output);
  }
}

function writeGitHubEnvironment(values) {
  const file = process.env.GITHUB_ENV;
  if (!file) {
    throw new Error("--write-github-env requires GITHUB_ENV");
  }
  const lines = [];
  for (const [name, value] of Object.entries(values)) {
    const delimiter = uniqueGitHubEnvDelimiter(value || "");
    lines.push(`${name}<<${delimiter}`);
    lines.push(value || "");
    lines.push(delimiter);
  }
  appendFileSync(file, `${lines.join("\n")}\n`);
}

function uniqueGitHubEnvDelimiter(value) {
  let delimiter = "";
  do {
    delimiter = `CLAWROUTER_ENV_${randomUUID().replaceAll("-", "_")}`;
  } while (value.includes(delimiter));
  return delimiter;
}
