export function assertFalRunDispatch(
  request: Request, prepared: { model: string; path: string },
  models: readonly string[], fail: (reason: string) => never,
): void {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== "https://fal.run" || url.pathname !== prepared.path
    || !models.includes(prepared.model) || prepared.path !== "/" + prepared.model
    || url.username || url.password || url.search || url.hash
    || !/^Key [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? "")
    || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("dispatch");
}
