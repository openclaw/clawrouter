import { HttpError } from "./http-error.ts";

export type AccessProgramsRejection = "protocol.access_programs_object" | "protocol.access_programs_keys"
  | "protocol.access_programs_type" | "protocol.access_programs_value";

export function accessProgramsRejection(programs: unknown): AccessProgramsRejection | null {
  if (programs == null) return null;
  if (typeof programs !== "object" || Array.isArray(programs)) return "protocol.access_programs_object";
  if (Object.keys(programs).length !== 1) return "protocol.access_programs_keys";
  const { cyber } = programs as Record<string, unknown>;
  if (!Object.hasOwn(programs, "cyber") || typeof cyber !== "string") return "protocol.access_programs_type";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(cyber)) return "protocol.access_programs_value";
  return null;
}

export function normalizeUnifiedAccessPrograms(body: Record<string, unknown>, supportsAccessPrograms: boolean): void {
  const programs = body.access_programs;
  if (programs === undefined) return;
  if (programs !== null) {
    if (accessProgramsRejection(programs))
      throw new HttpError(400, "model_parameter_unsupported", "access_programs must contain exactly one valid cyber token");
    if (supportsAccessPrograms) return;
    if ((programs as { cyber: string }).cyber !== "standard")
      throw new HttpError(400, "model_parameter_unsupported", "access_programs is unsupported for this route");
  }
  delete body.access_programs;
}
