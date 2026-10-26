import * as streamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";
import { none, type Many } from "stream-chain/core";

// stream-json's tokenizer stage is synchronous; its default `parser()` wraps it
// in async generator plumbing that cost more than the tokenizing itself. The
// pinned 3.7.0 exports the bare stage at runtime but not in its typings.
type TokenStage = (input: string | typeof none) => Many<Token> | typeof none;
const jsonParser = (streamJson as unknown as { jsonParser(options: ParserOptions): TokenStage }).jsonParser;

// Feed text, then `end()` once. Tokens of a feed are dispatched only after the
// whole feed tokenized, and a malformed feed throws before dispatching any.
export function createJsonTokenizer(accept: (token: Token) => void) {
  const step = jsonParser({ packValues: false, jsonStreaming: false });
  function feed(input: string | typeof none) {
    const tokens = step(input);
    if (tokens !== none) for (const token of tokens.values) accept(token);
  }
  return { push: (text: string) => feed(text), end: () => feed(none) };
}
