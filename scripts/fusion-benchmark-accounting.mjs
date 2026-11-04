export const models = { cheap: 'openai/gpt-6-luna', strong: 'openai/gpt-6.1-sol', critic: 'anthropic/claude-sonnet-5.5' };

export function priceBound(body, price) {
  // Preserve the pilot's conservative 4,096-token allowance even for smaller requests.
  const inputBytes = Buffer.byteLength(JSON.stringify(body)) + 1024;
  const applicable = (price.tiers ?? []).filter(t => t.minimum <= inputBytes);
  const input = Math.max(price.input, ...applicable.map(t => t.input));
  const output = Math.max(price.output, ...applicable.map(t => t.output));
  return Math.ceil((inputBytes * input + 4096 * output + price.request) * 1e6);
}
