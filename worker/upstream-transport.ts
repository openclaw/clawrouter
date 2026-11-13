// Server-owned transport capabilities, never client headers or policy fields.
// The native adapter supplies a request-local dispatch witness through its
// AsyncLocalStorage scope; ordinary Worker transports retain existing behavior.
const singleDispatch = new WeakMap<object, () => boolean | undefined>();

export function bindSingleDispatchTransport(env: object, dispatched: () => boolean | undefined): void {
  singleDispatch.set(env, dispatched);
}

export function permitsGrantFailover(env: object): boolean {
  return !singleDispatch.has(env);
}

export function transportDispatchStarted(env: object): boolean | undefined {
  return singleDispatch.get(env)?.();
}
