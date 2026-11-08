import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { PreparationAdmission, isPreparationLimit, preparationHeader, preparationReplace, resolveTemplate, resolveHeaderTemplate, optionalConfigKeys } = await import('../provider-templates.ts');
const { providerConfigurationList, normalizeConnectionMutation } = await import('../provider-connections.ts');
const { applyTransportHeaders } = await import('../provider-auth.ts');
const { providerById, configuredUpstream, upstreamPath, signSigV4 } = await import('../providers.ts');
const { prepareManifestRequest, concreteOpenAiSelection, isSelectionFailure, manifestEnvelope } = await import('../proxy-selection.ts');
const { prepareUpstreamRequest } = await import('../proxy-upstream-request.ts');
const { qualifyMiniMaxEnvironmentBinding } = await import('../native-media-credential.ts');
const { minimaxSpeechBinding } = await import('../../shared/native-media-binding.ts');
const { responseRouteDigest, prepareResponseControl } = await import('../responses-control-dispatch.ts');
const { sha256Hex } = await import('../utils.ts');

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

test('CSV processing has 32 KiB independently of the ordinary retained token projection', t => {
  let splits = 0; observe(t, String.prototype, 'split', original => function(...args) { splits++; return original.apply(this, args); });
  assert.deepEqual(providerConfigurationList('x' + ' '.repeat(32767), new PreparationAdmission()), ['x']);
  assert.throws(() => providerConfigurationList('x'.repeat(16385), new PreparationAdmission()), limited, 'source allowance does not enlarge retained values');
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

test('manifest envelope and preparation share declared relative-path admission at encoded exact/+1', () => {
  // Synthetic declared endpoint exercises the normal manifest copy and path validation.
  const endpoint = { ...providerById('openai').endpoints.find(e => e.id === 'responses'),
    path: '/fixture/${path}', upstreamPath: undefined, path_params: ['path'], path_param_styles: { path: 'relative_path' } };
  const relative = 'ü'.repeat(1364) + '/abcdefg', preparation = new PreparationAdmission();
  assert.equal(new TextEncoder().encode(relative).byteLength, 2736);
  const envelope = manifestEnvelope({ pathParams: { path: relative }, body: { input: 'fixture' } }, preparation, endpoint.path_param_styles);
  const prepared = prepareManifestRequest(fixture, endpoint, envelope.body, envelope.pathParams, {}, false, preparation);
  assert.equal(prepared.preparation, preparation);
  assert.notEqual(prepared.pathParams, envelope.pathParams);
  assert.equal(prepared.pathParams.path, relative);
  const auth = { baseUrl: 'https://provider.example', transportPaths: {} };
  const encoded = encodeURIComponent('ü'.repeat(1364)) + '/abcdefg';
  assert.equal(encoded.length, 8192);
  assert.equal(upstreamPath(fixture, endpoint, prepared.pathParams, {}, auth, preparation), '/fixture/' + encoded);
  for (const path of [relative + 'h', 'x'.repeat(4097), Array(65).fill('x').join('/')]) {
    const owner = new PreparationAdmission();
    assert.throws(() => {
      const rejected = manifestEnvelope({ pathParams: { path } }, owner, endpoint.path_param_styles);
      prepareManifestRequest(fixture, endpoint, rejected.body, rejected.pathParams, {}, false, owner);
    }, limited);
  }
  const owner = new PreparationAdmission();
  const unsafe = manifestEnvelope({ pathParams: { path: 'a/../b' } }, owner, endpoint.path_param_styles);
  const checked = prepareManifestRequest(fixture, endpoint, unsafe.body, unsafe.pathParams, {}, false, owner);
  assert.throws(() => upstreamPath(fixture, endpoint, checked.pathParams, {}, auth, owner), error => error.code === 'invalid_path_param');
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


test('manifest and null query entries never reach bulk value/record allocation', t => {
  const pathParams = Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['p' + i, 'x']));
  const ignored = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['ignored' + i, null]));
  ignored.a = ['1', '3']; ignored.b = true;
  const rejected = { a: Array(129).fill('x') }; let bulk = 0;
  observe(t, Object, 'values', original => function(value) { if (value === pathParams) bulk++; return original(value); });
  observe(t, Object, 'entries', original => function(value) { if (value === ignored || value === rejected) bulk++; return original(value); });
  assert.throws(() => manifestEnvelope({ pathParams }, new PreparationAdmission()), limited);
  assert.throws(() => manifestEnvelope({ pathParams: { x: 1 } }, new PreparationAdmission()), e => e.code === 'invalid_request_body');
  const provider = providerById('openai'), endpoint = provider.endpoints.find(e => e.id === 'responses');
  const selection = { provider, endpoint, pathParams: {}, body: {}, method: 'POST' };
  const upstream = configuredUpstream(provider, null, { OPENAI_API_KEY: 'synthetic-key' });
  const request = new Request('https://router.example/');
  const result = prepareUpstreamRequest(request, {}, selection, ignored, upstream, 'http', new PreparationAdmission());
  assert.equal(result.url.search, '?a=1&a=3&b=true');
  assert.throws(() => prepareUpstreamRequest(request, {}, selection, rejected, upstream, 'http', new PreparationAdmission()), limited);
  assert.equal(bulk, 0);
});

test('Headers-preserved NBSP counts before final writes and plans without trim allocation', t => {
  const names = ['aa', 'bb', 'cc', 'dd'], value = '\u00a0'.repeat(4096);
  const headers = new Headers(), owner = new PreparationAdmission(); let writes = 0, trims = 0;
  observe(t, Headers.prototype, 'set', original => function(...args) { if (this === headers) writes++; return original.apply(this, args); });
  observe(t, String.prototype, 'trim', original => function(...args) { if (String(this) === value) trims++; return original.apply(this, args); });
  for (const name of names.slice(0, 3)) preparationHeader(headers, name, value, owner);
  const before = trims;
  assert.throws(() => preparationHeader(headers, names[3], value, owner), limited);
  assert.equal(writes, 3); assert.equal(trims, before); assert.equal(headers.has('dd'), false);
  const exact = '\u00a0'.repeat(4092); // Three * (8192 + 2), plus (8184 + 2) = 32768.
  preparationHeader(headers, 'dd', exact, owner);
  assert.equal(headers.get('dd'), exact);
  const plan = names.map(name => [name, value]);
  assert.throws(() => new PreparationAdmission().headerPlan(new Headers(), plan), limited);
  plan[3][1] = exact; new PreparationAdmission().headerPlan(new Headers(), plan);
  plan[3][1] += 'x'; assert.throws(() => new PreparationAdmission().headerPlan(new Headers(), plan), limited);
});

test('connection mutation scalar admission precedes trim and preserves null/default semantics', t => {
  let trims = 0; const over = 'x'.repeat(16385);
  observe(t, String.prototype, 'trim', original => function(...args) { if (String(this) === over) trims++; return original.apply(this, args); });
  assert.equal(normalizeConnectionMutation({ label: 'x'.repeat(16384) }, 'p'.repeat(16384)).label.length, 16384);
  assert.throws(() => normalizeConnectionMutation({ label: over }, 'p'), limited);
  assert.throws(() => normalizeConnectionMutation({ label: over }, over), limited);
  assert.throws(() => normalizeConnectionMutation({}, over), limited);
  assert.equal(trims, 0);
  assert.deepEqual(normalizeConnectionMutation({}, 'p', true), { providerId: 'p', enabled: true, label: null });
  assert.deepEqual(normalizeConnectionMutation({}, 'p'), { providerId: 'p' });
  assert.deepEqual(normalizeConnectionMutation({ enabled: false, label: '  ', monthlyBudgetMicros: null }, 'p'), { providerId: 'p', enabled: false, label: null, monthlyBudgetMicros: null });
  assert.deepEqual(normalizeConnectionMutation({ label: null, monthlyBudgetMicros: 0 }, 'p'), { providerId: 'p', label: null, monthlyBudgetMicros: 0 });
  assert.throws(() => normalizeConnectionMutation({ label: {} }, 'p'), e => e.code === 'invalid_provider_connection');
});

test('CONTROL raw query admission precedes construction and counts decoded and raw occurrences', async t => {
  const overCount = Array(129).fill('a=1').join('&'), overName = '%61'.repeat(257) + '=x', overValue = 'a=' + 'v'.repeat(4097);
  const bad = new Set([overCount, overName, overValue]); let constructed = 0, authority = 0;
  observe(t, globalThis, 'URLSearchParams', Original => new Proxy(Original, { construct(target, args, receiver) { if (bad.has(args[0])) constructed++; return Reflect.construct(target, args, receiver); } }));
  const input = { owner: { providerId: 'openai', endpointId: 'responses' }, route: { pathParams: {}, organization: null, project: null },
    responseId: 'resp_fixture', action: 'retrieve', stream: false, authorization: { kind: 'public' } };
  const env = { ACCESS_CONTROL: { get() { authority++; throw Error('unexpected authority'); } } };
  for (const query of bad) await assert.rejects(prepareResponseControl(env, { ...input, query }, null), limited);
  assert.equal(constructed, 0); assert.equal(authority, 0);
  assert.equal(new PreparationAdmission().rawQuery('%61'.repeat(256) + '=' + 'v'.repeat(4096)).get('a'.repeat(256)).length, 4096);
  const owner = new PreparationAdmission(); assert.equal(owner.rawQuery(Array(128).fill('a=1').join('&')).size, 128);
  assert.throws(() => owner.query('a', 'next'), limited, 'parsed query does not reset the operation budget');
  assert.throws(() => new PreparationAdmission().rawQuery('&'.repeat(128)), limited, 'empty raw occurrences are charged');
  for (const query of ['?a=1&b=2&a=3', 'a=hello+world&b=%2B', '%EF%BB%BF=x', 'a=%E2%82&b=%ED%A0%80', 'a=%F0%9F%92%A9&b=ü', 'a=%GG%&b=\ud800']) {
    assert.deepEqual([...new PreparationAdmission().rawQuery(query)], [...new URLSearchParams(query)], query);
  }
  assert.throws(() => new PreparationAdmission().rawQuery('a=' + '%FF'.repeat(1366)), limited, 'decoded replacement bytes exceed the value ceiling');
  const exact = 'a=' + 'x'.repeat(4096) + '&b=' + 'x'.repeat(4091);
  assert.equal(new PreparationAdmission().rawQuery(exact).get('b').length, 4091);
  assert.throws(() => new PreparationAdmission().rawQuery(exact + 'x'), limited);
});

test('CSV ignores unknown tokens without copies and shares retained projection with ordinary facts', t => {
  const optionalProvider = { ...fixture, optional_config_keys: [] };
  const ignored = Array.from({ length: 200 }, (_, i) => 'UNKNOWN_' + i).join(','), source = 'v'; let slices = 0, retainedCopies = 0;
  observe(t, String.prototype, 'slice', original => function(...args) { if (String(this) === ignored) slices++; if (String(this) === source) retainedCopies++; return original.apply(this, args); });
  const full = new PreparationAdmission(); for (const key of ['a', 'b', 'c', 'd']) full.primitive(key, 'x'.repeat(16383));
  assert.deepEqual([...optionalConfigKeys(optionalProvider, { CLAWROUTER_OPTIONAL_CONFIG_KEYS: ignored }, full)], []);
  assert.equal(slices, 0);
  assert.throws(() => providerConfigurationList(source, full), limited);
  assert.equal(retainedCopies, 0, 'aggregate ordinary + CSV projection is checked before token copy');
  const count = new PreparationAdmission(); for (let i = 0; i < 127; i++) count.primitive('k' + i, 'v');
  const selected = ignored + ',FIXTURE_OPTIONAL';
  assert.deepEqual([...optionalConfigKeys(optionalProvider, { CLAWROUTER_OPTIONAL_CONFIG_KEYS: selected }, count)], ['FIXTURE_OPTIONAL']);
  assert.throws(() => count.primitive('last', 'v'), limited);
  assert.throws(() => optionalConfigKeys(optionalProvider, { CLAWROUTER_OPTIONAL_CONFIG_KEYS: Array(1025).fill('UNKNOWN').join(',') }, new PreparationAdmission()), limited);
  const raw = new PreparationAdmission();
  optionalConfigKeys(optionalProvider, { CLAWROUTER_OPTIONAL_CONFIG_KEYS: ' '.repeat(32768) }, raw);
  assert.throws(() => optionalConfigKeys(optionalProvider, { CLAWROUTER_OPTIONAL_CONFIG_KEYS: ',' }, raw), limited, 'ignored whitespace is still processed source');
});

test('literal replacement prefix/suffix expansion is metered without slice or replace on overflow', t => {
  const values = ['x'.repeat(8192) + '@', '@' + 'x'.repeat(8192)]; let slices = 0, replacements = 0;
  observe(t, String.prototype, 'slice', original => function(...args) { if (values.includes(String(this))) slices++; return original.apply(this, args); });
  observe(t, String.prototype, 'replace', original => function(...args) { if (values.includes(String(this))) replacements++; return original.apply(this, args); });
  assert.throws(() => preparationReplace(values[0], '@', () => "$`$`", new PreparationAdmission()), limited);
  assert.throws(() => preparationReplace(values[1], '@', () => "$'$'", new PreparationAdmission()), limited);
  assert.equal(slices, 0); assert.equal(replacements, 0);
  for (const replacement of ["$`", "$'", '$&', '$$', "$`-$&-$$-$'"]) {
    const value = 'before@after@';
    assert.equal(preparationReplace(value, '@', () => replacement, new PreparationAdmission()), value.replace('@', replacement));
  }
});

test('SigV4 synchronously projects primitives and never reads Env after its first suspension', async () => {
  const provider = providerById('aws-bedrock'), url = new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/example/invoke');
  const values = { AWS_ACCESS_KEY_ID: 'fixture-access', AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_REGION: 'us-east-1' }, reads = [];
  const { proxy, revoke } = Proxy.revocable(values, { get(target, key) { reads.push(key); return target[key]; }, ownKeys() { assert.fail('Env enumeration'); } });
  const headers = new Headers();
  const pending = signSigV4(provider, url, 'POST', '{}', headers, proxy, null, new Date('2026-01-01T00:00:00Z'), new PreparationAdmission());
  const outcome = pending.then(value => ({ failed: false, value }), error => ({ failed: true, error }));
  revoke();
  const result = await outcome; if (result.failed) throw result.error;
  assert.equal(result.value, 'us-east-1');
  assert.deepEqual(reads, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION']);
  assert.match(headers.get('authorization'), /^AWS4-HMAC-SHA256/);
});
