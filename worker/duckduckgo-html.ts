const maxHtmlBytes = 2 * 1024 * 1024;
const encoder = new TextEncoder();
export interface DuckDuckGoResult { title: string; url: string; snippet: string }

// Native HTML search, not the unrelated Instant Answers JSON API.
export function prepareDuckDuckGoSearch(query: URLSearchParams): { url: string; headers: Headers } {
  for (const key of query.keys()) if (!["q", "kl", "kp"].includes(key) || query.getAll(key).length !== 1) throw new Error("unsupported_duckduckgo_query");
  const q = query.get("q"), region = query.get("kl"), safe = query.get("kp") ?? "-1";
  if (!q?.trim() || encoder.encode(q).byteLength > 4096 || !["1", "-1", "-2"].includes(safe)
    || region !== null && !/^[a-z]{2}-[a-z]{2,3}$/.test(region)) throw new Error("invalid_duckduckgo_query");
  const url = new URL("https://html.duckduckgo.com/html");
  url.searchParams.set("q", q);
  if (region !== null) url.searchParams.set("kl", region);
  url.searchParams.set("kp", safe);
  return { url: url.href, headers: new Headers({ accept: "text/html", "user-agent": "clawrouter-duckduckgo/1 (+https://github.com/openclaw/clawrouter)" }) };
}

export async function readDuckDuckGoHtml(response: Response, count = 5): Promise<{ html: string; results: DuckDuckGoResult[] }> {
  if (response.redirected || response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/html" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_duckduckgo_response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxHtmlBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("duckduckgo_response_too_large");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let html = "", bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxHtmlBytes) throw new Error("duckduckgo_response_too_large");
      html += decoder.decode(next.value, { stream: true });
    }
    html += decoder.decode();
    return { html, results: parseDuckDuckGoHtml(html, count) };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof Error && /^duckduckgo_[a-z_]+$/.test(error.message)) throw error;
    throw new Error("invalid_duckduckgo_body");
  } finally { reader.releaseLock(); }
}

export function parseDuckDuckGoHtml(html: string, count = 5): DuckDuckGoResult[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20 || encoder.encode(html).byteLength > maxHtmlBytes) throw new Error("duckduckgo_invalid_bounds");
  if (/\bid\s*=\s*["']challenge-form["']|\bname\s*=\s*["']challenge["']|g-recaptcha/i.test(html)) throw new Error("duckduckgo_challenge");
  // Inert scripts/comments cannot supply visible search results.
  const visible = visibleHtml(html);
  const lower = visible.toLowerCase(), anchors = /<a\b/gi, results: DuckDuckGoResult[] = [];
  let current: DuckDuckGoResult | undefined, scanned = 0, resultAnchors = 0;
  for (;;) {
    const start = anchors.exec(visible);
    if (!start) break;
    if (++scanned > 2000) throw new Error("duckduckgo_layout_changed");
    const openEnd = visible.indexOf(">", start.index), close = lower.indexOf("</a>", openEnd + 1);
    if (openEnd < 0 || openEnd - start.index > 8192 || close < 0) throw new Error("duckduckgo_layout_changed");
    const attributes = anchorAttributes(visible.slice(start.index + 2, openEnd));
    const classes = (attributes.class ?? "").split(/\s+/), value = visible.slice(openEnd + 1, close);
    if (/<a\b/i.test(value)) throw new Error("duckduckgo_layout_changed");
    anchors.lastIndex = close + 4;
    if (classes.includes("result__a")) {
      resultAnchors++;
      const title = plainText(value), url = resultUrl(attributes.href ?? "");
      current = title && url ? { title, url, snippet: "" } : undefined;
      if (current && results.length < count) results.push(current);
    } else if (classes.includes("result__snippet") && current && !current.snippet) {
      current.snippet = plainText(value);
    }
  }
  if (!resultAnchors) {
    if (/are you a human/i.test(visible)) throw new Error("duckduckgo_challenge");
    if (!/class\s*=\s*["'][^"']*\b(?:no-results|result--no-result)\b/i.test(visible)) throw new Error("duckduckgo_layout_changed");
  } else if (!results.length) throw new Error("duckduckgo_invalid_results");
  return results;
}

function anchorAttributes(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of text.matchAll(/(?:^|\s)(class|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = match[1].toLowerCase();
    if (values[name] !== undefined) throw new Error("duckduckgo_layout_changed");
    values[name] = match[2] ?? match[3];
  }
  return values;
}

function plainText(value: string): string {
  return decodeEntities(value.replace(/<\/?b\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 8192);
}

function resultUrl(value: string): string | null {
  if (!value.trim()) return null;
  try {
    let url = new URL(decodeEntities(value), "https://duckduckgo.com");
    if (["duckduckgo.com", "html.duckduckgo.com"].includes(url.hostname) && url.pathname === "/l/" && url.searchParams.has("uddg")) url = new URL(url.searchParams.get("uddg")!);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) return null;
    return url.href;
  } catch { return null; }
}

function visibleHtml(html: string): string {
  const lower = html.toLowerCase(), begin = /<!--|<(?:script|style)\b/gi;
  let value = "", cursor = 0;
  for (;;) {
    const match = begin.exec(html);
    if (!match) return value + html.slice(cursor);
    value += html.slice(cursor, match.index);
    const closing = match[0] === "<!--" ? "-->" : "</" + match[0].slice(1).toLowerCase() + ">";
    const end = lower.indexOf(closing, begin.lastIndex);
    if (end < 0) throw new Error("duckduckgo_layout_changed");
    cursor = end + closing.length;
    begin.lastIndex = cursor;
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "--", hellip: "..." };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (_whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()];
    const cp = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\ufffd";
  });
}
