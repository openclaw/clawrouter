import parser, { type Token } from "stream-json/core/parser.js";
import { fun, none } from "stream-chain/core";

export { PolicyBindingIndexObject, BudgetLedgerObject, GrantCredentialObject, UsageLedgerObject } from "../../index.ts";

// This entry point qualifies the maintained parser under the real Worker flags.
// Fixture inputs are small; the product's bounded metadata observer is separate.
export default {
  async fetch(request: Request): Promise<Response> {
    const { chunks } = await request.json<{ chunks: string[] }>();
    const tokens: Token[] = [];
    const consume = fun(
      // EOF is a pipeline control input; it never reaches the parser as text.
      (input: string | typeof none): string | typeof none => input,
      parser({ packValues: false, jsonStreaming: false }),
      (token: Token): typeof none => { tokens.push(token); return none; },
    );
    try {
      for (const chunk of chunks) await consume(chunk);
      await consume(none);
      return Response.json({ tokens });
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
  },
} satisfies ExportedHandler;
