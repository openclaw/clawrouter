import { parseArgs } from "./cli-args.mjs";
import { adminRequest } from "./admin-api.mjs";
import { deploymentTarget } from "./deployment-profile.mjs";
import { localAdminEnvironment } from "./grant-target.mjs";

const args = parseArgs(process.argv.slice(2));
deploymentTarget();
const env = localAdminEnvironment(args);
const kid = required(args.kid, "--kid");
await adminRequest(`/v1/admin/keys/${encodeURIComponent(kid)}/revoke`, {
  method: "POST",
  env,
});
console.log(`revoked authoritative proxy credential ${kid}`);

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
