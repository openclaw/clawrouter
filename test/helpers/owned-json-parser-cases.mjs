export const ownedJsonCodecCases = [
  ['compact-object128', true], ['compact-object129', false], ['compact-open2048', false],
  ['compact-mixed', true], ['compact-wide', true], ['compact-key4096', true], ['compact-key4097', false],
  ['compact-number4096', true], ['compact-number4097', false], ['compact-string8192', true],
];

// This exact synthetic wire producer is also embedded in the native upstream.
// JSON.parse is the independent value oracle; raw bytes must remain unchanged.
export function ownedJsonCodecWire(mode, model) {
  const prefix = '{"model":' + JSON.stringify(model) + ',"extra":';
  let extra;
  if (mode === 'compact-object128' || mode === 'compact-object129') {
    const depth = mode === 'compact-object128' ? 127 : 128;
    extra = '{"child":'.repeat(depth) + '0' + '}'.repeat(depth);
  } else if (mode === 'compact-open2048') return prefix + '{"child":'.repeat(2048);
  else if (mode === 'compact-mixed') extra = '{"":{"child":[{"leaf":1},[2,3]],"sibling":4},"after":5,"\\ud800":{"\\udfff":6},"\\\"\\\\\\n":7,"__proto__":{"first":1},"__proto__":{"last":2},"text":"é😀\\ud800x\\udfff"}';
  else if (mode === 'compact-wide') extra = '[' + '{"a":[{"b":1},2],"after":3},'.repeat(1023) + '{"last":4}]';
  else if (mode === 'compact-key4096' || mode === 'compact-key4097') extra = '{"' + 'k'.repeat(mode === 'compact-key4096' ? 4096 : 4097) + '":0}';
  else if (mode === 'compact-number4096' || mode === 'compact-number4097') extra = '0.' + '0'.repeat(mode === 'compact-number4096' ? 4094 : 4095);
  else if (mode === 'compact-string8192') extra = '"' + 's'.repeat(8192) + '"';
  else throw new Error('unknown compact parser fixture case');
  return prefix + extra + ',"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}';
}
