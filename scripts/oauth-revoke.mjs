import { adminRequest } from "./admin-api.mjs";
import { parseArgs } from "./cli-args.mjs";
import { grantTarget } from "./grant-target.mjs";

const args = parseArgs(process.argv.slice(2));
const target = grantTarget(args);
const metadata = {};
for (const name of ["kind", "provider", "label"]) {
  if (args[name] === undefined) continue;
  if (typeof args[name] !== "string" || !args[name].trim()) throw new Error(`--${name} requires a value`);
  metadata[name] = args[name].trim();
}
await adminRequest(`${target.path}/revoke`, { method: "POST", body: metadata, env: target.env });
console.log(`revoked authoritative upstream grant ${target.key}; tombstone contains no secrets`);
