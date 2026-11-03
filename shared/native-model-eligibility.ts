// Worker entry point; keep the catalog self-contained for native Node and
// the admin compiler, which use different import-extension rules.
export { nativeModelEligible, nativeModelEligibilityRevision } from "./route-catalog.ts";
