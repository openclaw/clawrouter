import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const ticketFile = requiredOption(args, "ticket-file");
assertProtectedFile(ticketFile);
const ticket = JSON.parse(readFileSync(ticketFile, "utf8"));
if (ticket?.version !== 1 || typeof ticket.ticketToken !== "string" || typeof ticket.submissionUrl !== "string") throw new Error("ticket file is invalid");

const payload = {};
setOptional(payload, "credential", readSecret(args, "credential"));
setOptional(payload, "credentials", readSecretJson(args, "credentials-json"));
setOptional(payload, "accessToken", readSecret(args, "access-token"));
setOptional(payload, "refreshToken", readSecret(args, "refresh-token"));
setOptional(payload, "tokenType", optionalValue(args, "token-type"));
setOptional(payload, "expiresAt", optionalValue(args, "expires-at"));
setOptional(payload, "accountId", optionalValue(args, "account-id"));
const scopes = optionalValue(args, "scopes");
if (scopes) payload.scopes = [...new Set(scopes.split(",").map((value) => value.trim()).filter(Boolean))];
const plan = optionalValue(args, "subscription-plan"), subject = optionalValue(args, "subscription-subject");
if (plan || subject) payload.subscription = { ...(plan ? { plan } : {}), ...(subject ? { subject } : {}) };
if (!payload.credential && !payload.credentials && !payload.accessToken) throw new Error("a credential, credentials JSON, or access token source is required");

const response = await fetch(ticket.submissionUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${ticket.ticketToken}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(payload),
});
const body = await boundedJson(response);
if (!response.ok) throw new Error(`pool contribution failed (${response.status}): ${safeError(body)}`);
console.log(JSON.stringify({ outcome: body.outcome, receipt: body.receipt ?? null }));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const name = value.slice(2);
    if (values[index + 1] && !values[index + 1].startsWith("--")) result[name] = values[++index];
    else result[name] = true;
  }
  return result;
}

function readSecret(values, name) {
  if (values[name] !== undefined) throw new Error(`--${name} would expose the secret in process argv; use --${name}-ref, --${name}-env, or --${name}-file`);
  const reference = optionalValue(values, `${name}-ref`), envName = optionalValue(values, `${name}-env`), file = optionalValue(values, `${name}-file`);
  if ([reference, envName, file].filter(Boolean).length > 1) throw new Error(`use only one of --${name}-ref, --${name}-env, or --${name}-file`);
  if (reference) {
    if (!reference.startsWith("op://")) throw new Error(`--${name}-ref must be an op:// secret reference`);
    const executable = optionalValue(values, "op-bin") ?? "op";
    return required(execFileSync(executable, ["read", reference], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim(), `1Password ${name}`);
  }
  if (envName) return required(process.env[envName], `environment variable ${envName}`);
  if (file) return required(readFileSync(file, "utf8").trim(), `--${name}-file`);
  return undefined;
}

function readSecretJson(values, name) {
  const secret = readSecret(values, name);
  if (!secret) return undefined;
  let parsed;
  try { parsed = JSON.parse(secret); } catch { throw new Error(`${name} source must contain valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length || Object.values(parsed).some((value) => typeof value !== "string" || !value)) throw new Error(`${name} source must contain a non-empty string map`);
  return parsed;
}

function assertProtectedFile(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("ticket file must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("ticket file permissions are too broad; expected mode 0600");
}

function requiredOption(values, name) { return required(optionalValue(values, name), `--${name}`); }
function required(value, name) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function optionalValue(values, name) { const value = values[name]; if (value === undefined) return undefined; if (value === true) throw new Error(`--${name} requires a value`); return value.trim(); }
function setOptional(object, key, value) { if (value !== undefined) object[key] = value; }
async function boundedJson(response) { const text = await response.text(); if (text.length > 128 * 1024) throw new Error("server response was too large"); try { return JSON.parse(text); } catch { throw new Error("server returned invalid JSON"); } }
function safeError(body) { return typeof body?.error?.message === "string" ? body.error.message : "request rejected"; }
