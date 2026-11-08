import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PreparationAdmission, isPreparationLimit, preparationHeader, preparationReplace, resolveTemplate, resolveHeaderTemplate } from '../provider-templates.ts';
import { providerConfigurationList } from '../provider-connections.ts';
import { applyTransportHeaders } from '../provider-auth.ts';
import { providerById, configuredUpstream, upstreamPath, signSigV4 } from '../providers.ts';
import { prepareManifestRequest, concreteOpenAiSelection, isSelectionFailure } from '../proxy-selection.ts';
import { prepareUpstreamRequest } from '../proxy-upstream-request.ts';
import { qualifyMiniMaxEnvironmentBinding } from '../native-media-credential.ts';
import { minimaxSpeechBinding } from '../../shared/native-media-binding.ts';
import { responseRouteDigest, prepareResponseControl } from '../responses-control-dispatch.ts';
import { sha256Hex } from '../utils.ts';

const limited = error => isPreparationLimit(error) && error.status === 503 && error.code === 'provider_preparation_unavailable';
const fixture = { ...providerById('openrouter'), id: 'fixture', config_keys: ['FIXTURE_VALUE', 'FIXTURE_OPTIONAL'], optional_config_keys: ['FIXTURE_OPTIONAL'] };
function observe(t, object, key, wrap) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  assert.equal(typeof descriptor?.value, 'function');
  t.after(() => Object.defineProperty(object, key, descriptor)); // Before installation, even if an assertion fails.
  Object.defineProperty(object, key, { ...descriptor, value: wrap(descriptor.value) });
}

test('selected primitive projection admits exact limits, retains overwritten facts and never enumerates Env', () => {
  const owner = new PreparationAdmission(); let unused = 0, enumerated = 0;
  const env = new Proxy({ FIXTURE_VALUE: ' value ', get UNUSED() { unused++; throw Error('unused'); } }, { ownKeys() { enumerated++; throw Error('enumeration'); } });
  assert.equal(resolveTemplate(fixture, '${value}', env, owner), ' value ');
  assert.equal(unused, 0); assert.equal(enumerated, 0); assert.equal(JSON.stringify(owner), '{}', 'primitive facts are private, including during selection serialization');
  assert.throws(() => resolveTemplate(fixture, '${value}', { FIXTURE_VALUE: {} }, new PreparationAdmission()), limited);
  assert.equal(new PreparationAdmission().primitive('x'.repeat(256), 'v'), 'v');
  assert.throws(() => new PreparationAdmission().primitive('x'.repeat(257), 'v'), limited);
  assert.equal(new PreparationAdmission().primitive('v', 'x'.repeat(16384)).length, 16384);
  assert.throws(() => new PreparationAdmission().primitive('v', 'x'.repeat(16385)), limited);
  const count = new PreparationAdmission(); for (let i = 0; i < 128; i++) count.primitive('k' + i, 'v');
  assert.throws(() => count.primitive('extra', 'v'), limited);
  const bytes = new PreparationAdmission();
  for (const key of ['a', 'b', 'c', 'd']) bytes.primitive(key, 'x'.repeat(16383));
  assert.throws(() => bytes.primitive('a', 'replacement'), limited, 'overwriting does not refund retained bytes');
  assert.equal(isPreparationLimit({ status: 503, code: 'provider_preparation_unavailable' }), false);
  let error; try { owner.primitive('secret', 'synthetic-private-value'.repeat(1000)); } catch (value) { error = value; }
  assert.ok(limited(error)); assert.doesNotMatch(JSON.stringify(error), /synthetic-private-value/);
});

test('CSV has its own 32 KiB allowance and counts raw empty entries before split', t => {
  let splits = 0; observe(t, String.prototype, 'split', original => function(...args) { splits++; return original.apply(this, args); });
  assert.equal(providerConfigurationList('x'.repeat(32768), new PreparationAdmission())[0].length, 32768);
  const before = splits;
  assert.throws(() => providerConfigurationList('x'.repeat(32769), new PreparationAdmission()), limited);
  assert.equal(splits, before);
  assert.deepEqual(providerConfigurationList(','.repeat(1023), new PreparationAdmission()), []);
  const now = splits;
  assert.throws(() => providerConfigurationList(','.repeat(1024), new PreparationAdmission()), limited); assert.equal(splits, now);
  const shared = new PreparationAdmission(); providerConfigurationList('x'.repeat(16384), shared); providerConfigurationList('y'.repeat(16384), shared);
  assert.throws(() => providerConfigurationList('z', shared), limited);
  const csv = 'FIXTURE_OPTIONAL,' + ' '.repeat(17000);
  assert.equal(resolveHeaderTemplate(fixture, '${optional}', { CLAWROUTER_OPTIONAL_CONFIG_KEYS: csv }, new PreparationAdmission()), null);
});

test('complete template expansion and all required bindings precede replace or optional omission', t => {
  const exact = '${value}'.repeat(256), over = '${value}'.repeat(257); let replacements = 0;
  observe(t, String.prototype, 'replace', original => function(...args) { if (String(this) === over) replacements++; return original.apply(this, args); });
  assert.equal(resolveTemplate(fixture, exact, { FIXTURE_VALUE: 'x' }, new PreparationAdmission()), 'x'.repeat(256));
  assert.throws(() => resolveTemplate(fixture, over, { FIXTURE_VALUE: 'x' }, new PreparationAdmission()), limited); assert.equal(replacements, 0);
  assert.throws(() => resolveTemplate(fixture, '${value}${value}', { FIXTURE_VALUE: 'x'.repeat(8193) }, new PreparationAdmission()), limited);
  assert.throws(() => resolveHeaderTemplate(fixture, '${optional}${value}', {}, new PreparationAdmission()), error => error.code === 'provider_not_configured');
  assert.equal(resolveHeaderTemplate(fixture, '${optional}${value}', { FIXTURE_VALUE: 'v' }, new PreparationAdmission()), null);
  const value = 'prefix ${secret} suffix ${secret}', secret = '$&$$';
  assert.equal(preparationReplace(value, '${secret}', () => secret, new PreparationAdmission()), value.replace('${secret}', secret));
  const shared = new PreparationAdmission(); resolveTemplate(fixture, '${value}'.repeat(128), { FIXTURE_VALUE: 'v' }, shared);
  resolveTemplate(fixture, '${value}'.repeat(128), { FIXTURE_VALUE: 'v' }, shared);
  assert.throws(() => resolveTemplate(fixture, '${value}', { FIXTURE_VALUE: 'v' }, shared), limited);
});

test('path occurrence, segment, raw and encoded limits precede copying and encoding', () => {
  new PreparationAdmission().paths(Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['p' + i, 'x'])));
  assert.throws(() => new PreparationAdmission().paths(Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['p' + i, 'x']))), limited);
  new PreparationAdmission().path('x'.repeat(4096));
  assert.throws(() => new PreparationAdmission().path('x'.repeat(4097)), limited);
  const encoded = 'ü'.repeat(1365) + 'xx'; // 2732 raw bytes, exactly 8192 encoded.
  assert.equal(new PreparationAdmission().path(encoded), 8192);
  assert.throws(() => new PreparationAdmission().path(encoded + 'x'), limited);
  new PreparationAdmission().path(Array(64).fill('x').join('/'), true, true);
  assert.throws(() => new PreparationAdmission().path(Array(65).fill('x').join('/'), true, true), limited);
  const repeated = new PreparationAdmission(); for (let i = 0; i < 32; i++) repeated.path('x');
  assert.throws(() => repeated.path('x'), limited);
  const endpoint = { ...fixture.endpoints[0], lifecycle: {}, path_param_styles: {} };
  assert.throws(() => prepareManifestRequest(fixture, endpoint, {}, { p: 'x'.repeat(4097) }, {}, false, new PreparationAdmission()), limited);
  const provider = providerById('aws-bedrock'), endpoint2 = provider.endpoints.find(e => e.path_params.includes('model'));
  const auth = { baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', transportPaths: {} };
  const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/example/model';
  assert.equal(upstreamPath(provider, endpoint2, { model: arn }, { AWS_REGION: 'us-east-1' }, auth, new PreparationAdmission()),
    upstreamPath(provider, endpoint2, { model: arn }, { AWS_REGION: 'us-east-1' }, auth));
});

test('query conversion counts repeated writes and preserves protected/interleaved values', () => {
  const pairs = new PreparationAdmission(); for (let i = 0; i < 128; i++) pairs.query('a', '');
  assert.throws(() => pairs.query('a', ''), limited);
  new PreparationAdmission().query('n'.repeat(256), 'v'.repeat(4096));
  assert.throws(() => new PreparationAdmission().query('n'.repeat(257), 'v'), limited);
  assert.throws(() => new PreparationAdmission().query('n', 'v'.repeat(4097)), limited);
  const exact = new PreparationAdmission(); exact.query('a', 'x'.repeat(4096)); exact.query('b', 'x'.repeat(4091));
  const over = new PreparationAdmission(); over.query('a', 'x'.repeat(4096)); assert.throws(() => over.query('b', 'x'.repeat(4092)), limited);
  const provider = providerById('openai'), endpoint = provider.endpoints.find(e => e.id === 'responses');
  const selection = { provider, endpoint, pathParams: {}, body: {}, method: 'POST' };
  const upstream = { ...configuredUpstream(provider, null, { OPENAI_API_KEY: 'synthetic-key' }), query: new URLSearchParams('protected=original') };
  const request = new Request('https://router.example/');
  const prepared = prepareUpstreamRequest(request, {}, selection, new URLSearchParams('a=1&b=2&a=3'), upstream, 'http', new PreparationAdmission());
  assert.equal(prepared.url.search, '?protected=original&a=1&b=2&a=3');
  assert.throws(() => prepareUpstreamRequest(request, {}, selection, { protected: 'override' }, upstream, 'http', new PreparationAdmission()), error => error.code === 'protected_query_parameter');
  assert.throws(() => prepareUpstreamRequest(request, {}, selection, { a: Array(129).fill('') }, upstream, 'http', new PreparationAdmission()), limited);
});

test('header write, final count, value/name and cumulative byte limits are independent', () => {
  const count = new PreparationAdmission(), headers = new Headers();
  for (let i = 0; i < 256; i++) preparationHeader(headers, 'a', 'x', count);
  assert.throws(() => preparationHeader(headers, 'a', 'x', count), limited);
  const final = new PreparationAdmission(), many = new Headers();
  for (let i = 0; i < 64; i++) preparationHeader(many, 'h' + i, 'v', final);
  assert.throws(() => preparationHeader(many, 'extra', 'v', final), limited); assert.equal([...many].length, 64);
  preparationHeader(new Headers(), 'n'.repeat(128), 'v'.repeat(8192), new PreparationAdmission());
  assert.throws(() => preparationHeader(new Headers(), 'n'.repeat(129), 'v', new PreparationAdmission()), limited);
  assert.throws(() => preparationHeader(new Headers(), 'n', 'v'.repeat(8193), new PreparationAdmission()), limited);
  const bytes = new PreparationAdmission(), same = new Headers();
  for (let i = 0; i < 8; i++) preparationHeader(same, 'a', 'x'.repeat(8191), bytes);
  assert.throws(() => preparationHeader(same, 'a', '', bytes), limited);
  const output = new Headers(), budget = new PreparationAdmission();
  for (const name of ['a', 'b', 'c', 'd']) preparationHeader(output, name, 'x'.repeat(8191), budget);
  assert.throws(() => preparationHeader(output, 'e', '', budget), limited);
});

test('transport comma merge is admitted before split and preserves trim/dedup precedence', t => {
  const transport = { headers: {}, appendHeaders: { 'x-features': '${grant.accountId}' } }, grant = { accountId: ' b , a,c ' };
  const headers = new Headers({ 'x-features': ' a, b ' });
  applyTransportHeaders(headers, transport, grant, new PreparationAdmission()); assert.equal(headers.get('x-features'), 'a,b,c');
  let split = 0; observe(t, String.prototype, 'split', original => function(...args) { split++; return original.apply(this, args); });
  const huge = new Headers({ 'x-features': 'a'.repeat(8192) });
  assert.throws(() => applyTransportHeaders(huge, transport, { accountId: 'b' }, new PreparationAdmission()), limited);
  assert.equal(split, 0); assert.equal(huge.get('x-features'), 'a'.repeat(8192));
});

test('base and built URL ceilings and selected configuration stay distinct from missing configuration', () => {
  new PreparationAdmission().url('x'.repeat(4096), 'y'.repeat(12288));
  assert.throws(() => new PreparationAdmission().url('x'.repeat(4097)), limited);
  assert.throws(() => new PreparationAdmission().url('x'.repeat(4096), 'y'.repeat(12289)), limited);
  assert.throws(() => configuredUpstream(providerById('openai'), null, {}, undefined, new PreparationAdmission()), error => !isPreparationLimit(error) && error.code === 'provider_not_configured');
  const aliases = providerById('abliteration');
  const selected = configuredUpstream(aliases, null, { ABLIT_KEY: 'synthetic-first', ABLITERATION_API_KEY: 'synthetic-second' }, undefined, new PreparationAdmission());
  assert.equal(selected.headers.get('authorization'), 'Bearer synthetic-first');
  const request = concreteOpenAiSelection('/v1/responses', { model: 'openai/gpt-6-astra' }, {});
  assert.equal(isSelectionFailure(request), false); assert.ok(request.preparation instanceof PreparationAdmission);
});

test('owned SigV4 preserves deterministic canonical bytes and selected incomplete-grant denial', async () => {
  const provider = providerById('aws-bedrock'), url = new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/example/invoke?z=last&a=space+value&a=%C3%BC');
  const env = { AWS_ACCESS_KEY_ID: 'fixture-access', AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_REGION: 'us-east-1' }, now = new Date('2026-01-01T00:00:00Z');
  const legacy = new Headers({ 'content-type': 'application/json' }), admitted = new Headers(legacy);
  await signSigV4(provider, url, 'POST', '{}', legacy, env, null, now);
  await signSigV4(provider, url, 'POST', '{}', admitted, env, null, now, new PreparationAdmission());
  assert.deepEqual([...admitted], [...legacy]); assert.ok(admitted.get('authorization').startsWith('AWS4-HMAC-SHA256'));
  await assert.rejects(signSigV4(provider, url, 'POST', '{}', new Headers(), env, { credentials: { accessKeyId: 'only-one' } }, now, new PreparationAdmission()), error => error.code === 'provider_not_configured');
});

test('media attestation reads fresh primitives after the actual digest and never turns capacity into null', async t => {
  const provider = providerById('minimax'), secret = 'synthetic-minimax', fingerprint = await sha256Hex(secret);
  const binding = JSON.stringify({ ...minimaxSpeechBinding, credentialSource: 'MINIMAX_API_KEY', credentialSha256: fingerprint });
  const env = { MINIMAX_API_KEY: secret, CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING: binding };
  assert.ok(await qualifyMiniMaxEnvironmentBinding(provider, env, 'minimax.speech', new PreparationAdmission()));
  observe(t, Object.getPrototypeOf(crypto.subtle), 'digest', original => async function(...args) {
    const result = await original.apply(this, args); env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING = {}; return result;
  });
  await assert.rejects(qualifyMiniMaxEnvironmentBinding(provider, env, 'minimax.speech', new PreparationAdmission()), limited);
});


test('selected route digest preserves exact legacy bytes and never creates a replacement owner', async () => {
  const provider = providerById('openai'), env = { OPENAI_API_KEY: 'synthetic-key' };
  const upstream = configuredUpstream(provider, null, env), url = new URL(upstream.baseUrl + '/responses');
  const headers = new Headers(upstream.headers); headers.set('openai-project', 'fixture-project');
  const expected = await responseRouteDigest(provider, upstream, url, headers, null);
  assert.equal(await responseRouteDigest(provider, upstream, url, headers, null, undefined, env, {}, undefined, new PreparationAdmission()), expected);
  headers.set('openai-project', 'p'.repeat(8193));
  assert.match(await responseRouteDigest(provider, upstream, url, headers, null), /^[a-f0-9]{64}$/);
  await assert.rejects(responseRouteDigest(provider, upstream, url, headers, null, undefined, env, {}, undefined, new PreparationAdmission()), limited);
  let authority = 0;
  const input = { owner: { providerId: 'openai', endpointId: 'responses', grantKey: null, lineage: null, routeSha256: expected },
    route: { pathParams: {}, organization: null, project: null }, responseId: 'resp_fixture', action: 'retrieve', query: '', stream: false,
    authorization: { kind: 'public' } };
  await assert.rejects(prepareResponseControl({ OPENAI_API_KEY: 'x'.repeat(16385), ACCESS_CONTROL: { get() { authority++; throw Error('unexpected authority'); } } }, input, null), limited);
  assert.equal(authority, 0);
});

test('SigV4 generated authorization admission occurs before crypto', async t => {
  let digests = 0;
  observe(t, Object.getPrototypeOf(crypto.subtle), 'digest', original => function(...args) { digests++; return original.apply(this, args); });
  await assert.rejects(signSigV4(providerById('aws-bedrock'), new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/example/invoke'),
    'POST', '{}', new Headers(), { AWS_ACCESS_KEY_ID: 'a'.repeat(8192), AWS_SECRET_ACCESS_KEY: 'synthetic-secret', AWS_REGION: 'us-east-1' },
    null, new Date('2026-01-01T00:00:00Z'), new PreparationAdmission()), limited);
  assert.equal(digests, 0);
});
