import type { HttpOperation } from "./http-operation.ts";
import { createCopilotAccountProjection, type CopilotAccountProjection } from "./copilot-account-projection.ts";
import { consumeCopilotResponse } from "./copilot-response-stream.ts";

// The returned projection is still UNQUALIFIED: no URL canonicalization,
// account/token authority, freshness, routing or capacity decision occurs here.
export function readCopilotAccountResponse(response: Response, input: Readonly<{
  operation: HttpOperation;
  expectedUrl: string;
}>): Promise<CopilotAccountProjection> {
  return consumeCopilotResponse(response, { ...input, profile: "account" }, createCopilotAccountProjection);
}
