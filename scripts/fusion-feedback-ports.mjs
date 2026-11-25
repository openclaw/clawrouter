// Diagnostic text only: callers must retain raw evidence and verdicts separately.
export function normalizeLoopbackUrlPorts(feedback) {
  if (typeof feedback !== 'string') throw new TypeError('feedback must be a string');
  const ports = new Map();
  // Avoid confusing generated aliases with literal text already in the feedback.
  let prefix = '<loopback-port';
  while (feedback.includes(prefix)) prefix += '-';
  // Consume the whole outer URL so nested URLs in its path/query stay literal.
  return feedback.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, url => url.replace(
    /^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):)([1-9][0-9]{0,4})(?=[/?#),;\]}]|$)/i,
    (authorityWithPort, authority, port) => {
      if (Number(port) > 65535) return authorityWithPort;
      if (!ports.has(port)) ports.set(port, `${prefix}:${ports.size + 1}>`);
      return authority + ports.get(port);
    },
  ));
}
