import { HttpError } from "./utils.ts";

export type ProxyQuery = URLSearchParams | Record<string, unknown>;

export function hasProxyQuery(query: ProxyQuery): boolean {
  return query instanceof URLSearchParams ? query.size > 0 : Object.keys(query).length > 0;
}

export function applyProxyQuery(target: URLSearchParams, input: ProxyQuery, protectedKeys: Iterable<string> = []): void {
  const query = input instanceof URLSearchParams ? input : manifestQuery(input);
  for (const name of protectedKeys) if (query.has(name)) throw new HttpError(400, "protected_query_parameter", "caller query cannot replace credential or operator upstream query parameters");
  // Caller keys replace unprotected endpoint defaults, as before. Delete once, then append
  // the entire ordered sequence: set() would collapse repeats and interleaving.
  query.forEach((_value, name) => target.delete(name));
  query.forEach((value, name) => target.append(name, value));
}

function manifestQuery(input: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (value == null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!["string", "number", "boolean"].includes(typeof item)) throw new HttpError(400, "invalid_request_body", "manifest query values must be scalars or arrays of scalars");
      query.append(name, String(item));
    }
  }
  return query;
}
