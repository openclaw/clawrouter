import { HttpError } from "./http-error.ts";

// Internal selection context only: never add grant identity to public errors.
export class SelectedGrantCredentialFailure extends HttpError {
  readonly grantKey: string;
  constructor(error: HttpError, grantKey: string) {
    super(error.status, error.code, error.message, error.headers);
    this.grantKey = grantKey;
  }
}

export function selectedCredentialFailure(error: unknown, grantKey: string): unknown {
  return error instanceof HttpError && ["grant_refresh_failed", "grant_refresh_at_risk", "grant_refresh_persist_failed", "grant_reauthorization_required", "grant_credential_missing"].includes(error.code)
    ? new SelectedGrantCredentialFailure(error, grantKey) : error;
}
