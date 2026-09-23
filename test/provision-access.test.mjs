import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const fixtureEnv = {
  CLOUDFLARE_ACCOUNT_ID: "account-placeholder",
  CLOUDFLARE_API_TOKEN: "fixture-token",
  CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "example.com",
  CLAWROUTER_ACCESS_DOMAIN: "clawrouter.example.com",
};

test("Access provisioning protects the browser OAuth callback by default", () => {
  const result = spawnSync(process.execPath, ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...fixtureEnv,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clawrouter\.example\.com\/dashboard\/\*/);
  assert.match(result.stdout, /clawrouter\.example\.com\/v1\/session\*/);
  assert.match(result.stdout, /clawrouter\.example\.com\/v1\/admin\/\*/);
  assert.match(result.stdout, /clawrouter\.example\.com\/v1\/oauth\/callback/);
  assert.doesNotMatch(result.stdout, /clawrouter\.example\.com\/v1\/entitlements/);
  const destinations = result.stdout.match(/^destinations=(.+)$/m)?.[1].split(",") ?? [];
  assert.equal(destinations.length, 5);
});

test("Access provisioning supports an exact GitHub organization rule", () => {
  const result = spawnSync(process.execPath, ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...fixtureEnv,
      CLAWROUTER_ACCESS_ALLOWED_EMAILS: "",
      CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "",
      CLAWROUTER_ACCESS_ADMIN_EMAILS: "break-glass@example.com",
      CLAWROUTER_ACCESS_ADMIN_DOMAINS: "example.com",
      CLAWROUTER_ACCESS_GITHUB_ORGS: "openclaw,openclaw/maintainers",
      CLAWROUTER_ACCESS_IDP_IDS: "github-idp-explicit",
      CLAWROUTER_ACCESS_DOMAIN: "clawrouter.example.com",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^githubOrganizations=openclaw,openclaw\/maintainers$/m);
  assert.match(result.stdout, /^githubIdentityProviderSource=configured$/m);
  assert.match(result.stdout, /^policy=ClawRouter Console Users decision=allow$/m);
  assert.match(result.stdout, /^humanIncludeKinds=github-organization$/m);
});

test("Access provisioning rejects malformed GitHub organization selectors", () => {
  const result = spawnSync(process.execPath, ["scripts/provision-access.mjs", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...fixtureEnv,
      CLAWROUTER_ACCESS_ALLOWED_EMAILS: "",
      CLAWROUTER_ACCESS_ALLOWED_DOMAINS: "",
      CLAWROUTER_ACCESS_ADMIN_EMAILS: "",
      CLAWROUTER_ACCESS_ADMIN_DOMAINS: "",
      CLAWROUTER_ACCESS_GITHUB_ORGS: "openclaw/team/extra",
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid GitHub organization rule/);
});

function accessApp(id, domain, overrides = {}) {
  return { id, domain, type: "self_hosted", name: "ClawRouter Console", ...overrides };
}

async function runCloudflareFixture(fixture) {
  const calls = [];
  const appPath = "/client/v4/accounts/account-placeholder/access/apps";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== "https://api.cloudflare.com") throw new Error("unexpected API origin");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: url.pathname, page: url.searchParams.get("page"), body });
    let result;
    if (init.method === "GET" && url.pathname === "/client/v4/accounts/account-placeholder/access/organizations") {
      result = { auth_domain: "fixture.cloudflareaccess.com" };
    } else if (init.method === "GET" && url.pathname === appPath) {
      const page = Number(url.searchParams.get("page") || 1);
      if (page === fixture.failPage) throw new Error("fixture page unavailable");
      result = fixture.pages[page - 1] ?? [];
    } else if (init.method === "GET" && url.pathname.endsWith("/policies")) {
      const page = Number(url.searchParams.get("page") || 1);
      result = fixture.policyPages?.[page - 1] ?? [];
    } else if (["PUT", "POST", "DELETE"].includes(init.method) && url.pathname.startsWith(appPath)) {
      result = { ...body, id: body?.id || "created-app", aud: "fixture-audience" };
    } else {
      throw new Error(`unexpected API request: ${init.method} ${url.pathname}`);
    }
    return Response.json({ success: true, result });
  };
  let error;
  try {
    await import("../scripts/provision-access.mjs");
  } catch (caught) {
    error = caught.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ calls, error }));
}

function provision(fixture, env = {}) {
  // Run the real CLI with synthetic credentials and a fetch replacement. No
  // operator environment or network request can reach the fixture's execution.
  const source = `await (${runCloudflareFixture.toString()})(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(fixture)], {
    cwd: new URL(".", import.meta.url),
    encoding: "utf8",
    env: { ...fixtureEnv, ...env },
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  const recorded = JSON.parse(result.stdout.trim().split("\n").at(-1));
  return { ...recorded, status: result.status, stdout: result.stdout };
}

test("Access provisioning updates the destination match even when another app has its name", () => {
  const result = provision({ pages: [[
    accessApp("other-app", "other.example.com/dashboard/*"),
    accessApp("intended-app", "clawrouter.example.com/dashboard/*", { name: "Previous console name" }),
  ]] });
  assert.equal(result.status, 0, result.error);
  const writes = result.calls.filter((call) => call.method !== "GET");
  assert.equal(writes[0].path, "/client/v4/accounts/account-placeholder/access/apps/intended-app");
  assert.equal(writes[0].body.domain, "clawrouter.example.com/dashboard/*");
  assert.ok(writes.every((call) => call.path.includes("/intended-app")));
  assert.match(result.stdout, /^aud=fixture-audience$/m);
});

for (const [label, overrides] of [
  ["public destination", { destinations: [{ type: "public", uri: "clawrouter.example.com/v1/session*" }] }],
  ["legacy destination", { self_hosted_domains: ["clawrouter.example.com/v1/session*"] }],
  ["bare hostname", { domain: "clawrouter.example.com" }],
]) {
  test(`Access provisioning identifies an existing app by ${label}`, () => {
    const result = provision({ pages: [[accessApp("intended-app", "clawrouter.example.com/old-path", overrides)]] });
    assert.equal(result.status, 0, result.error);
    assert.equal(result.calls.find((call) => call.method === "PUT")?.body.id, "intended-app");
  });
}

test("Access provisioning rejects a name-only collision without writes", () => {
  const result = provision({ pages: [[accessApp("other-app", "other.example.com/dashboard/*")]] });
  assert.equal(result.status, 1);
  assert.match(result.error, /already belongs to another destination.*CLAWROUTER_ACCESS_APP_NAME/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning ignores legacy domains when destinations is provided", () => {
  const result = provision({ pages: [[accessApp("other-app", "other.example.com/dashboard/*", {
    destinations: [],
    self_hosted_domains: ["clawrouter.example.com/dashboard/*"],
  })]] });
  assert.equal(result.status, 1);
  assert.match(result.error, /already belongs to another destination/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning refuses ambiguous destination ownership even when one name matches", () => {
  const result = provision({ pages: [[
    accessApp("first-app", "clawrouter.example.com/dashboard/*"),
    accessApp("second-app", "clawrouter.example.com/v1/session*", { name: "Other console" }),
  ]] });
  assert.equal(result.status, 1);
  assert.match(result.error, /multiple Access applications match.*resolve overlapping destinations/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning does not convert another application type", () => {
  const result = provision({ pages: [[accessApp("other-app", "clawrouter.example.com/dashboard/*", { type: "saas" })]] });
  assert.equal(result.status, 1);
  assert.match(result.error, /not self_hosted/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning creates an app when neither destination nor name exists", () => {
  const result = provision({ pages: [[accessApp("other-app", "other.example.com/dashboard/*", { name: "Other console" })]] });
  assert.equal(result.status, 0, result.error);
  const create = result.calls.find((call) => call.method !== "GET");
  assert.equal(create.method, "POST");
  assert.equal(create.path, "/client/v4/accounts/account-placeholder/access/apps");
  assert.equal(create.body.name, "ClawRouter Console");
  assert.equal(create.body.domain, "clawrouter.example.com/dashboard/*");
});

test("Access provisioning finds the destination beyond the first account page", () => {
  const result = provision({ pages: [
    [accessApp("other-app", "other.example.com/dashboard/*")],
    [accessApp("intended-app", "clawrouter.example.com/dashboard/*")],
  ] });
  assert.equal(result.status, 0, result.error);
  assert.equal(result.calls.find((call) => call.method === "PUT")?.body.id, "intended-app");
  assert.deepEqual(result.calls.filter((call) => call.path.endsWith("/apps")).map((call) => call.page), ["1", "2", "3"]);
});

test("Access provisioning checks later account pages before allowing writes", () => {
  const result = provision({ pages: [
    [accessApp("first-app", "clawrouter.example.com/dashboard/*")],
    [accessApp("second-app", "clawrouter.example.com/dashboard/*")],
  ] });
  assert.equal(result.status, 1);
  assert.match(result.error, /multiple Access applications match/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning stops when the account inventory cannot be completed", () => {
  const result = provision({ pages: [[accessApp("intended-app", "clawrouter.example.com/dashboard/*")]], failPage: 2 });
  assert.equal(result.status, 1);
  assert.match(result.error, /fixture page unavailable/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});

test("Access provisioning checks unmanaged policies beyond their first page", () => {
  const result = provision({
    pages: [[accessApp("intended-app", "clawrouter.example.com/dashboard/*")]],
    policyPages: [
      [{ id: "managed-policy", name: "ClawRouter Console Users", decision: "allow" }],
      [{ id: "unmanaged-policy", name: "Unmanaged bypass", decision: "bypass" }],
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.error, /unmanaged policies.*Unmanaged bypass/);
  assert.ok(result.calls.every((call) => call.method === "GET"));
});
