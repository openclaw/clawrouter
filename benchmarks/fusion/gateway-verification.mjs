export const GATEWAY_VERIFICATION_REVISION = 'gateway-boundaries-v1';

/** Optional visible checks for function candidates, separate from hidden grading. */
export function gatewayVerificationCases(contract) {
  if (contract === 'stream-stop-match') {
    const text = 'pre🦊ENDtail', token = '🦊END', cases = [];
    for (const split of [0, 4, text.length]) {
      const chunks = [text.slice(0, split), text.slice(split)];
      cases.push({ args: [{ chunks, stops: ['absent', token, token] }], expected: { text: 'pre', stopIndex: 1 } });
      for (const position of [0, 1, 2, 3]) for (const count of [1, 2]) {
        const stops = ['absent', token, token];
        stops.splice(position, 0, ...Array(count).fill(''));
        cases.push({ args: [{ chunks: [...chunks], stops }],
          expected: { text: 'pre', stopIndex: position <= 1 ? 1 + count : 1 } });
      }
    }
    return cases;
  }
  if (contract === 'json-pointer-read') {
    const cases = [];
    for (const document of [null, false, 0, 'value', [], {}, { a: 1 }]) {
      cases.push({ args: [{ document, pointer: '' }], expected: { found: true, value: structuredClone(document) } });
      for (const pointer of ['missing', 'a', '0', '~1', '/a~', '/a~2', '/~9']) {
        cases.push({ args: [{ document: structuredClone(document), pointer }], expected: { found: false } });
      }
    }
    for (const pointer of ['/01', '/-1', '/+1', '/1.0', '/-', '/2']) {
      cases.push({ args: [{ document: [1, 2], pointer }], expected: { found: false } });
    }
    cases.push({ args: [{ document: { 'a/b': { '~': false } }, pointer: '/a~1b/~0' }], expected: { found: true, value: false } });
    cases.push({ args: [{ document: { '': 0 }, pointer: '/' }], expected: { found: true, value: 0 } });
    return cases;
  }
  throw new Error('unsupported_gateway_verification_contract');
}
