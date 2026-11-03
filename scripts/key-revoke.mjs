import { legacyCredential, putLocalKeyRecords, readLocalKeyRecord, writeKeyJson } from "./local-key-kv.mjs";
import { parseArgs } from "./cli-args.mjs";
import { adminRequest } from "./admin-api.mjs";

const args = parseArgs(process.argv.slice(2));
const kid = required(args.kid, "--kid");
const binding = args.binding ?? "POLICY_KV";
const config = args.config ?? ".wrangler.generated.toml";

if (!args.local) {
  await adminRequest(`/v1/admin/keys/${encodeURIComponent(kid)}/revoke`, {
    method: "POST",
    responseMode: "ack",
  });
  console.log(`revoked authoritative proxy credential ${kid}`);
} else {
  revokeLocalBootstrapRecord();
  console.log(`revoked local KV proxy credential ${kid}`);
}

function revokeLocalBootstrapRecord() {
  const legacy = readLocalKeyRecord(`keys/${kid}`, { binding, config, allowMissing: true });
  const credential =
    readLocalKeyRecord(`credentials/${kid}`, { binding, config, allowMissing: true }) ?? legacyCredential(legacy, kid);
  if (!credential) {
    throw new Error(`proxy credential ${kid} was not found`);
  }
  credential.enabled = false;
  if (legacy) legacy.enabled = false;
  const records = [
    [`credentials/${kid}`, writeKeyJson(credential, "credential.json")],
    ...(legacy ? [[`keys/${kid}`, writeKeyJson(legacy, "legacy-key.json")]] : []),
  ];

  putLocalKeyRecords(records, { binding, config });
}

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
