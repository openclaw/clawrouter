import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRequest } from "./admin-api.mjs";

const prefix = "/v1/admin/grant-pools";
const nextAction = "Open /dashboard/access?resource=upstream and accept the storage baseline after checking the account inventory and stopping legacy writers. Then run pnpm cf:accounts.";
const recoveryRequest = (path, options) => adminRequest(path, { ...options, signal: AbortSignal.timeout(30_000) });

export function grantPoolStatus({ request = recoveryRequest } = {}) {
  return request(`${prefix}/readiness`, { method: "GET" });
}

// This is an explicit administrative attestation. A provisioner may choose
// fresh only after it created the bound storage in the same invocation.
export async function acceptGrantPoolBaseline(baseline, { request = recoveryRequest } = {}) {
  if (!["fresh", "existing"].includes(baseline)) throw new Error("baseline must be fresh or existing");
  const state = await grantPoolStatus({ request });
  if (state.baseline) throw new Error("baseline already accepted; use recovery without another acceptance");
  return request(`${prefix}/baseline`, { method: "POST", body: { revision: state.revision, baseline, confirmed: true } });
}

export async function recoverGrantPools({ request = recoveryRequest, maxPages = 128, repairCursor = null, onPage = () => {} } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1024) throw new Error("maxPages must be from 1 to 1024");
  if (repairCursor !== null && (typeof repairCursor !== "string" || !repairCursor || repairCursor.length > 1024)) throw new Error("repair cursor must be a nonempty indexed key");
  let state = await grantPoolStatus({ request });
  if (!state.baseline) throw new Error(`account routing baseline is not accepted. ${nextAction}`);
  if (state.activatedAt) {
    let cursor = repairCursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await request(`${prefix}/repair`, { method: "POST", body: { cursor } });
      onPage(result);
      if (result.outcomes.some(outcome => outcome.reason)) throw new Error("account repair remains unresolved; inspect the reported keys in Access → Upstream");
      if (!result.cursor) return result.readiness;
      cursor = result.cursor;
    }
    const quotedCursor = `'${cursor.replaceAll("'", "'\\''")}'`;
    throw Object.assign(new Error(`account recovery page limit reached; resume with pnpm cf:accounts -- --repair-cursor ${quotedCursor}`), { repairCursor: cursor });
  }
  if (repairCursor !== null) throw new Error("repair cursor is only valid after activation; initial migration must complete its saved scan");
  if (state.phase === "idle" || state.phase === "complete") state = await request(`${prefix}/scan`, { method: "POST", body: { revision: state.revision } });
  let verificationStarted = false;
  for (let page = 0; page < maxPages; page++) {
    if (state.phase !== "complete") {
      const result = await request(`${prefix}/advance`, { method: "POST", body: { scanRevision: state.scanRevision, phase: state.phase, cursor: state.cursor } });
      state = result.readiness;
      onPage(result);
    }
    if (state.phase !== "complete") continue;
    if (state.issues.length || state.overflow) throw new Error("account migration remains unresolved; use cf:oauth:put with secret stdin/file to replace the reported legacy account, or cf:oauth:revoke to remove it, then restart recovery");
    if (state.revision !== state.scanRevision) {
      // Owner backfill changes the source revision. One new verification scan
      // is justified by those writes; concurrent changes never silently pass.
      if (verificationStarted) throw new Error("accounts changed during verification; stop legacy writers and rerun recovery");
      verificationStarted = true;
      state = await request(`${prefix}/scan`, { method: "POST", body: { revision: state.revision } });
      continue;
    }
    return request(`${prefix}/activate`, { method: "POST", body: { revision: state.revision } });
  }
  throw new Error("account migration page limit reached; progress is saved, rerun recovery to continue");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  const repairCursor = args[0] === "--repair-cursor" && args.length === 2 ? args[1] : null;
  if (repairCursor === null && (args.length > 1 || args.some(arg => !["--status", "--accept-existing", "--accept-fresh"].includes(arg)))) throw new Error("usage: pnpm cf:accounts [-- --status | --accept-existing | --accept-fresh | --repair-cursor KEY]");
  if (args[0] === "--status") console.log(JSON.stringify(await grantPoolStatus(), null, 2));
  else if (args[0]?.startsWith("--accept-")) {
    const state = await acceptGrantPoolBaseline(args[0].slice("--accept-".length));
    console.log(`account baseline accepted: ${state.baseline}; run pnpm cf:accounts to scan and activate`);
  } else {
    const state = await recoverGrantPools({ repairCursor, onPage: result => {
      for (const outcome of result.outcomes) if (outcome.reason) console.error(JSON.stringify(outcome));
    } });
    console.log(`account attachment routing active at revision ${state.revision}`);
  }
}
