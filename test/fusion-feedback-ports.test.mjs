import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLoopbackUrlPorts as normalize } from '../scripts/fusion-feedback-ports.mjs';

test('replayed redirect failures retain path differences while normalizing ephemeral ports', () => {
  const failure = port => `expected: 'http://localhost:${port}/300/3'\nactual: 'http://localhost:${port}/300/4'`;
  assert.equal(normalize(failure(43301)), normalize(failure(36243)));
  assert.equal(normalize(failure(43301)), "expected: 'http://localhost:<loopback-port:1>/300/3'\nactual: 'http://localhost:<loopback-port:1>/300/4'");
  assert.notEqual(normalize(failure(43301)), normalize(failure(43301).replace('/300/4', '/300/3')));
});

test('preserves equality and inequality of ports across loopback URL hosts', () => {
  const input = 'http://localhost:1234/a https://127.0.0.1:5678/b http://[::1]:1234/c HTTPS://LOCALHOST:5678/d?q=1234#5678';
  assert.equal(normalize(input), 'http://localhost:<loopback-port:1>/a https://127.0.0.1:<loopback-port:2>/b http://[::1]:<loopback-port:1>/c HTTPS://LOCALHOST:<loopback-port:2>/d?q=1234#5678');
  assert.notEqual(normalize(input), normalize(input.replace(':5678/b', ':1234/b')));
});

test('leaves external URLs, unsupported endpoints, malformed ports and ordinary numbers intact', () => {
  const input = [
    'https://example.com:1234/a', 'http://localhost.example:1234/a',
    'http://user@localhost:1234/a', 'ftp://localhost:1234/a', 'localhost:1234',
    'http://localhost:0/a', 'http://localhost:01234/a', 'http://localhost:65536/a',
    'http://localhost:123456/a', 'http://localhost:1234abc/a', 'http://localhost:-1234/a',
    'http://localhost:1234.5/a', 'http://localhost:1234@other/a',
    'expected: 1234 actual: 5678', '<loopback-port:1>',
  ].join('\n');
  assert.equal(normalize(input), input);
});

test('supports valid port boundaries and punctuation, without changing URL content', () => {
  assert.equal(normalize('(http://localhost:1), "https://[::1]:65535?port=1#65535"'),
    '(http://localhost:<loopback-port:1>), "https://[::1]:<loopback-port:2>?port=1#65535"');
});

test('preserves nested URLs in outer paths, queries and fragments', () => {
  for (const suffix of ['/http://localhost:1234/a', '?next=http://localhost:1234/a', '#http://localhost:1234/a']) {
    for (const outer of ['https://example.com', 'ftp://localhost:5678']) {
      assert.equal(normalize(outer + suffix), outer + suffix);
    }
    assert.equal(normalize('http://localhost:5678' + suffix), 'http://localhost:<loopback-port:1>' + suffix);
  }
  assert.equal(normalize('xhttp://localhost:1234/a'), 'xhttp://localhost:1234/a');
});

test('avoids preexisting alias collisions and leaves normalized feedback unchanged', () => {
  const input = '<loopback-port:1> http://localhost:1234/a';
  const output = '<loopback-port:1> http://localhost:<loopback-port-:1>/a';
  assert.equal(normalize(input), output);
  assert.equal(normalize(output), output);
  assert.equal(normalize(''), '');
  for (const value of [null, undefined, 1234, {}, []]) assert.throws(() => normalize(value), TypeError);
});
