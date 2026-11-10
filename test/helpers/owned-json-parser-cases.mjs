export const ownedJsonCodecCases = [
  ['compact-object128', true], ['compact-object-string128', true], ['compact-object129', false], ['compact-open2048', false],
  ['compact-mixed', true], ['compact-wide', true], ['compact-key4096', true], ['compact-key4097', false],
  ['compact-number4096', true], ['compact-number4097', false], ['compact-string8192', true], ['compact-numeric', true], ['compact-strict-space', false], ['compact-invalid-eof', false],
];

export const ownedUsageCases = ['wide', 'deep', 'quoted', 'scalar', 'malformed', 'many-lines', 'refusal-omitted',
  'refusal-cleared', 'refusal-null', 'refusal-large', 'refusal-again', 'two-large', 'missing-usage', 'content', 'mixed', 'unfinished', 'overflow'];

// Shared synthetic accepted-byte producer. It is installed only on the actual
// fixture reader, after its original read settles; it is never a production cap.
export function ownedUsageWire(name, streaming) {
  const counts = '"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}';
  let json;
  if (name === 'wide') json = '{"extra":[' + '[],'.repeat(599999) + '[]]}';
  else if (name === 'deep') json = '{"extra":' + '['.repeat(1025) + '0' + ']'.repeat(1025) + ',' + counts + '}';
  else if (name === 'quoted') json = '{"__proto__":{"a":1},"__proto__":{"b":2},"":"\\ud800\\udfff\\\"\\\\","x":"é😀","x":"last",' + counts + '}';
  else if (name === 'scalar') json = '"' + 'x'.repeat(8193) + '\\ud800"';
  else if (name === 'malformed') json = '{"duplicate":"first","duplicate":"unfinished\\u';
  else if (name === 'many-lines') json = '{' + '\n'.repeat(40000) + counts + '}';
  else if (name === 'overflow') json = '{"extra":"' + 'x'.repeat(2097152) + '"}';
  if (json !== undefined) return streaming ? (name === 'many-lines' ? json.split('\n').map(line => 'data: ' + line).join('\n') : 'data: ' + json) + '\n\n' : json;
  if (!streaming) throw new Error('SSE-only usage fixture');
  const frame = value => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
  const start = stop => ({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 }, content: [], stop_reason: stop } });
  let wire = frame(start('refusal'));
  if (name === 'missing-usage') wire = frame({ type: 'message_start', message: { content: [], stop_reason: 'refusal' } });
  if (name === 'two-large') wire = frame(start(Array.from({ length: 570000 }, () => []))) + frame(start(Array.from({ length: 570000 }, () => [])));
  if (name === 'content') wire += frame({ type: 'content_block_delta', delta: { text: 'work' } });
  const delta = { type: 'message_delta', usage: { output_tokens: 3 }, delta: {} };
  if (name === 'refusal-cleared') delta.delta.stop_reason = 'end_turn';
  if (name === 'refusal-null') delta.delta.stop_reason = null;
  if (name === 'refusal-large') delta.delta.stop_reason = { unknown: 'x'.repeat(1800000) };
  if (name === 'refusal-again') { delta.delta.stop_reason = null; wire += frame(delta); delta.delta.stop_reason = 'refusal'; }
  wire += frame(delta);
  if (name === 'mixed') wire += 'event: error\ndata: {"usage":{"prompt_tokens":9},"error":null}\n\n';
  if (name === 'unfinished') return wire + 'data: {"usage":{"prompt_tokens":99}';
  return wire + frame({ type: 'message_stop' });
}

export function ownedCodecSseLines(model, mode) {
  const line = mode === 'line-error' ? 'event:\u00a0error\u202f\r\n' : '';
  const blanks = mode === 'line-limit' ? 252 : mode === 'line-plus' ? 253 : 3;
  return line + 'data: {"model":' + JSON.stringify(model) + ',\n'
    + 'data: \n'.repeat(blanks) + 'data: "extra":{"child":[],"after":1},\r\n'
    + 'data: "usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n'
    + 'data: [DONE]\n\n';
}

// This exact synthetic wire producer is also embedded in the native upstream.
// JSON.parse is the independent value oracle; raw bytes must remain unchanged.
export function ownedJsonCodecWire(mode, model) {
  const prefix = '{"model":' + JSON.stringify(model) + ',"extra":';
  let extra;
  if (mode === 'compact-object128' || mode === 'compact-object-string128' || mode === 'compact-object129') {
    const depth = mode === 'compact-object129' ? 128 : 127;
    extra = '{"child":'.repeat(depth) + (mode === 'compact-object-string128' ? '"leaf"' : '0') + '}'.repeat(depth);
  } else if (mode === 'compact-open2048') return prefix + '{"child":'.repeat(2048);
  else if (mode === 'compact-mixed') extra = '{"":{"child":[{"leaf":1},[2,3]],"sibling":4},"after":5,"\\ud800":{"\\udfff":6},"\\\"\\\\\\n":7,"__proto__":{"first":1},"__proto__":{"last":2},"text":"é😀\\ud800x\\udfff"}';
  else if (mode === 'compact-wide') extra = '[' + '{"a":[{"b":1},2],"after":3},'.repeat(1023) + '{"last":4}]';
  else if (mode === 'compact-key4096' || mode === 'compact-key4097') extra = '{"' + 'k'.repeat(mode === 'compact-key4096' ? 4096 : 4097) + '":0}';
  else if (mode === 'compact-number4096' || mode === 'compact-number4097') extra = '0.' + '0'.repeat(mode === 'compact-number4096' ? 4094 : 4095);
  else if (mode === 'compact-string8192') extra = '"' + 's'.repeat(8192) + '"';
  else if (mode === 'compact-numeric') extra = '{"negativeZero":-0,"large":1e309,"rounded":9007199254740993,"duplicate":1,"duplicate":2}';
  else if (mode === 'compact-strict-space') extra = '[\u00a00]';
  else if (mode === 'compact-invalid-eof') return prefix + '"unfinished\\u';
  else if (mode === 'compact-bom') return '\ufeff' + ownedJsonCodecWire('compact-mixed', model);
  else throw new Error('unknown compact parser fixture case');
  return prefix + extra + ',"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}';
}
