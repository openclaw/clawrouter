// Synthetic-only authenticated/native upgrade evidence. No production clients or credentials.
import { provePersonalUsageUpgrade } from "../test/helpers/personal-usage-upgrade.mjs";
const proof=await provePersonalUsageUpgrade({eventsPerOwner:300,artifactPath:"docs/proof/personal-usage/authenticated-upgrade.json"});
console.log(JSON.stringify(proof,null,2));
