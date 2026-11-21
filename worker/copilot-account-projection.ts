export type CopilotAccountProjection = Readonly<{ endpoints?: Readonly<{ api?: string | null }> }>;

// Local operational policy, not documented provider maxima or a capacity charge.
const WIRE = 16 * 1024 * 1024, DEPTH = 64, CONTAINERS = 512, MEMBERS = 2048, ENTRIES = 2048, VALUES = 4097, URL_UNITS = 4096;
const KEY_OR_END = 0, KEY = 1, COLON = 2, OBJECT_VALUE = 3, OBJECT_COMMA = 4, VALUE_OR_END = 5, ARRAY_VALUE = 6, ARRAY_COMMA = 7;
const NONE = 0, STRING = 1, NUMBER = 2, LITERAL = 3;
const SIGN = 0, ZERO = 1, INTEGER = 2, DOT = 3, FRACTION = 4, EXPONENT = 5, EXP_SIGN = 6, EXP_DIGITS = 7;
const whitespace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const digit = (code: number) => code >= 48 && code <= 57;

/** Incremental account-only projection. Consumes borrowed bytes synchronously;
 * no transport, credential, URL authority, JSON AST or general parser API. */
export function createCopilotAccountProjection(): Readonly<{
  push(bytes: Uint8Array): void;
  finish(): CopilotAccountProjection;
}> {
  // Per frame: grammar state, authority scope (root/endpoints/ignored), key role.
  const stack = new Uint16Array(DEPTH * 3), url = new Uint16Array(URL_UNITS);
  let depth = 0, bytes = 0, containers = 0, members = 0, entries = 0, values = 0;
  let decodedUnits = 0, urlLength = 0, endpointsSeen = false, apiSeen = false, apiNull = false;
  let started = false, finished = false, poisoned = false, firstScalar = true;
  let utfRemaining = 0, utfValue = 0, utfMinimum = 0;
  let lex = NONE, isKey = false, capture = false, keyTarget = "", keyLength = 0, keyMatches = false;
  let escape = 0, hexValue = 0, hexLeft = 0, numberState = SIGN, literal = "", literalOffset = 0;
  const fail = (): never => { poisoned = true; throw new Error("invalid_copilot_account_projection"); };
  const active = () => { if (poisoned || finished) fail(); };
  const unit = (code: number) => {
    // Every decoded key/string unit, including ignored values, is bounded by wire.
    if (++decodedUnits > WIRE) fail();
    if (isKey) {
      if (keyLength >= keyTarget.length || keyTarget.charCodeAt(keyLength) !== code) keyMatches = false;
      keyLength++;
    } else if (capture) {
      if (urlLength === URL_UNITS) fail();
      url[urlLength++] = code;
    }
  };
  const startString = (key: boolean, retain: boolean) => {
    lex = STRING; isKey = key; capture = retain; escape = 0;
    keyLength = 0; keyMatches = true;
    keyTarget = key ? (stack[(depth - 1) * 3 + 1] === 1 ? "endpoints" : stack[(depth - 1) * 3 + 1] === 2 ? "api" : "") : "";
  };
  const endString = () => {
    lex = NONE;
    if (!isKey) return;
    const frame = (depth - 1) * 3, scope = stack[frame + 1];
    let role = 0;
    if (keyMatches && keyLength === keyTarget.length) {
      if (scope === 1) { if (endpointsSeen) fail(); endpointsSeen = true; role = 1; }
      if (scope === 2) { if (apiSeen) fail(); apiSeen = true; role = 2; }
    }
    stack[frame + 2] = role; stack[frame] = COLON;
  };
  const startValue = (code: number) => {
    const frame = (depth - 1) * 3, state = depth ? stack[frame] : -1;
    const role = depth ? stack[frame + 2] : 3;
    if ((role === 3 || role === 1) && code !== 123) fail();
    if (role === 2 && code !== 34 && code !== 110) fail();
    if (++values > VALUES) fail();
    if (depth) {
      const array = state === VALUE_OR_END || state === ARRAY_VALUE;
      if (array && ++entries > ENTRIES) fail();
      stack[frame] = array ? ARRAY_COMMA : OBJECT_COMMA;
    } else { if (started) fail(); started = true; }
    if (code === 123 || code === 91) {
      if (depth === DEPTH || ++containers > CONTAINERS) fail();
      const next = depth++ * 3;
      stack[next] = code === 123 ? KEY_OR_END : VALUE_OR_END;
      stack[next + 1] = role === 3 ? 1 : role === 1 ? 2 : 0;
      stack[next + 2] = 0;
    } else if (code === 34) startString(false, role === 2);
    else if (code === 116 || code === 102 || code === 110) {
      lex = LITERAL; literal = code === 116 ? "true" : code === 102 ? "false" : "null"; literalOffset = 1;
      if (role === 2) apiNull = true;
    } else if (code === 45 || digit(code)) {
      lex = NUMBER; numberState = code === 45 ? SIGN : code === 48 ? ZERO : INTEGER;
    } else fail();
  };
  const scalar = (code: number) => {
    if (firstScalar) { firstScalar = false; if (code === 0xfeff) return; }
    if (lex === STRING) {
      if (escape === 2) {
        const hex = digit(code) ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
        if (hex < 0) fail();
        hexValue = hexValue * 16 + hex;
        if (--hexLeft === 0) { unit(hexValue); escape = 0; }
      } else if (escape === 1) {
        escape = 0;
        if (code === 117) { escape = 2; hexValue = 0; hexLeft = 4; }
        else if (code === 34 || code === 92 || code === 47) unit(code);
        else if (code === 98) unit(8);
        else if (code === 102) unit(12);
        else if (code === 110) unit(10);
        else if (code === 114) unit(13);
        else if (code === 116) unit(9);
        else fail();
      } else if (code === 34) endString();
      else if (code === 92) escape = 1;
      else if (code < 32) fail();
      else if (code <= 0xffff) unit(code);
      else { unit(0xd800 + ((code - 0x10000) >> 10)); unit(0xdc00 + ((code - 0x10000) & 1023)); }
      return;
    }
    if (lex === LITERAL) {
      if (code !== literal.charCodeAt(literalOffset++)) fail();
      if (literalOffset === literal.length) lex = NONE;
      return;
    }
    if (lex === NUMBER) {
      if (numberState === SIGN) { if (!digit(code)) fail(); numberState = code === 48 ? ZERO : INTEGER; return; }
      if (numberState === DOT || numberState === EXP_SIGN) { if (!digit(code)) fail(); numberState = numberState === DOT ? FRACTION : EXP_DIGITS; return; }
      if (numberState === EXPONENT) {
        if (code === 43 || code === 45) numberState = EXP_SIGN;
        else if (digit(code)) numberState = EXP_DIGITS;
        else fail();
        return;
      }
      if (digit(code)) { if (numberState === ZERO) fail(); return; }
      if (code === 46 && (numberState === ZERO || numberState === INTEGER)) { numberState = DOT; return; }
      if ((code === 101 || code === 69) && (numberState === ZERO || numberState === INTEGER || numberState === FRACTION)) { numberState = EXPONENT; return; }
      lex = NONE; // Reprocess this delimiter in the surrounding grammar.
    }
    if (whitespace(code)) return;
    if (!depth) { startValue(code); return; }
    const frame = (depth - 1) * 3, state = stack[frame];
    if (state === KEY_OR_END || state === KEY) {
      if (code === 125 && state === KEY_OR_END) { depth--; return; }
      if (code !== 34 || ++members > MEMBERS) fail();
      startString(true, false);
    } else if (state === COLON) {
      if (code !== 58) fail();
      stack[frame] = OBJECT_VALUE;
    } else if (state === OBJECT_VALUE || state === ARRAY_VALUE || state === VALUE_OR_END) {
      if (code === 93 && state === VALUE_OR_END) { depth--; return; }
      startValue(code);
    } else if (state === OBJECT_COMMA || state === ARRAY_COMMA) {
      if (code === (state === OBJECT_COMMA ? 125 : 93)) depth--;
      else if (code === 44) stack[frame] = state === OBJECT_COMMA ? KEY : ARRAY_VALUE;
      else fail();
    } else fail();
  };
  return Object.freeze({
    push(chunk: Uint8Array): void {
      active();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > WIRE - bytes) fail();
      bytes += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength; offset++) {
        const byte = chunk[offset];
        if (!utfRemaining) {
          if (byte < 128) scalar(byte);
          else if (byte >= 0xc2 && byte <= 0xdf) { utfRemaining = 1; utfValue = byte & 31; utfMinimum = 0x80; }
          else if (byte >= 0xe0 && byte <= 0xef) { utfRemaining = 2; utfValue = byte & 15; utfMinimum = 0x800; }
          else if (byte >= 0xf0 && byte <= 0xf4) { utfRemaining = 3; utfValue = byte & 7; utfMinimum = 0x10000; }
          else fail();
        } else {
          if (byte < 0x80 || byte > 0xbf) fail();
          utfValue = utfValue * 64 + (byte & 63);
          if (--utfRemaining === 0) {
            if (utfValue < utfMinimum || utfValue > 0x10ffff || (utfValue >= 0xd800 && utfValue <= 0xdfff)) fail();
            scalar(utfValue);
          }
        }
      }
    },
    finish(): CopilotAccountProjection {
      active();
      if (utfRemaining || lex !== NONE || depth !== 0 || !started) fail();
      finished = true;
      // One bounded argument vector and final string, without per-unit strings.
      const api: string | null = apiSeen && !apiNull ? Reflect.apply(String.fromCharCode, undefined, url.subarray(0, urlLength)) : null;
      url.fill(0); stack.fill(0);
      if (!endpointsSeen) return Object.freeze({});
      return Object.freeze({ endpoints: Object.freeze(apiSeen ? { api } : {}) });
    },
  });
}
