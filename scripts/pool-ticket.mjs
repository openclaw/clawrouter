import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const baseUrl = requiredOption(args, "url").replace(/\/$/, "");
const output = requiredOption(args, "out");
const adminToken = readSecret(args, "admin-token");
const payload = {
  scope: requiredOption(args, "scope"),
  scopeId: requiredOption(args, "scope-id"),
  tokenRef: requiredOption(args, "token-ref"),
  provider: requiredOption(args, "provider"),
  kind: optionalValue(args, "kind") ?? "subscription",
};
setOptional(payload, "label", optionalValue(args, "label"));
setOptional(payload, "contributor", optionalValue(args, "contributor"));
setOptional(payload, "priority", optionalNumber(args, "priority"));
setOptional(payload, "weight", optionalNumber(args, "weight"));
setOptional(payload, "ttlSeconds", optionalNumber(args, "ttl-seconds"));
if (args["keep-warm"] === true) payload.keepWarm = true;

const response = await fetch(`${baseUrl}/v1/admin/pool-submission-tickets`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(payload),
});
const body = await boundedJson(response);
if (!response.ok) throw new Error(`ticket issuance failed (${response.status}): ${safeError(body)}`);
if (typeof body?.ticketToken !== "string" || typeof body?.submissionUrl !== "string" || !body?.ticket?.id) throw new Error("ticket issuance returned an invalid response");

const descriptor = JSON.stringify({ version: 1, ticket: body.ticket, ticketToken: body.ticketToken, submissionUrl: new URL(body.submissionUrl, `${baseUrl}/`).toString() }, null, 2) + "\n";
const handle = openSync(output, "wx", 0o600);
try { writeFileSync(handle, descriptor); } finally { closeSync(handle); }
console.log(`wrote protected submission ticket ${body.ticket.id} to ${output}; secret was not printed`);

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
  if (values[name] !== undefined) throw new Error(`--${name} would expose the secret in process argv; use --${name}-env or --${name}-stdin`);
  const envName = optionalValue(values, `${name}-env`);
  const stdin = values[`${name}-stdin`];
  if (envName && stdin) throw new Error(`use only one of --${name}-env or --${name}-stdin`);
  if (envName) return required(process.env[envName], `environment variable ${envName}`);
  if (stdin === true) return required(readFileSync(0, "utf8"), `stdin ${name}`);
  throw new Error(`--${name}-env or --${name}-stdin is required`);
}

function requiredOption(values, name) { return required(optionalValue(values, name), `--${name}`); }
function required(value, name) { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function optionalValue(values, name) { const value = values[name]; if (value === undefined) return undefined; if (value === true) throw new Error(`--${name} requires a value`); return value.trim(); }
function optionalNumber(values, name) { const value = optionalValue(values, name); if (value === undefined) return undefined; const number = Number(value); if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`); return number; }
function setOptional(object, key, value) { if (value !== undefined) object[key] = value; }
async function boundedJson(response) { const text = await response.text(); if (text.length > 128 * 1024) throw new Error("server response was too large"); try { return JSON.parse(text); } catch { throw new Error("server returned invalid JSON"); } }
function safeError(body) { return typeof body?.error?.message === "string" ? body.error.message : "request rejected"; }
