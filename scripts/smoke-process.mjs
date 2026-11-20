export function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(exited) {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    }
    child.once("exit", onExit);
  });
}
