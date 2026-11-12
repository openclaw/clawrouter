import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {runtimeFields,runtimeProviderOrigins}=await import('../large-http/provider-config.ts');
const {runtimeConfig}=await import('../large-http/config.ts');

test('native configuration contains only Responses provider declarations and router policy flags',()=>{
 for(const field of ['OPENAI_API_KEY','OPENROUTER_API_KEY','OPENROUTER_SITE_URL','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_API_KEY','MODEL_API_KEY'])assert.ok(runtimeFields.includes(field));
 for(const field of ['ANTHROPIC_API_KEY','CLOUDFLARE_API_TOKEN','GITHUB_CLIENT_SECRET','LARGE_HTTP_TOKEN'])assert.equal(runtimeFields.includes(field),false);
 assert.equal(new Set(runtimeFields).size,runtimeFields.length);
 const origins=runtimeProviderOrigins({AZURE_OPENAI_ENDPOINT:'https://fixture.openai.azure.com/'});
 assert.deepEqual(origins.sort(),['https://api.meta.ai','https://api.openai.com','https://chatgpt.com','https://fixture.openai.azure.com','https://openrouter.ai'].sort());
 for(const endpoint of [undefined,'bad-origin','file:///private/example','https://user:secret@fixture.openai.azure.com'])assert.equal(runtimeProviderOrigins({AZURE_OPENAI_ENDPOINT:endpoint}).includes('https://fixture.openai.azure.com'),false);
 assert.equal(runtimeProviderOrigins({UNRELATED_ENDPOINT:'https://arbitrary.example'}).includes('https://arbitrary.example'),false);
});

test('provider configuration changes retire the native epoch without persisting secret values',async()=>{
 const env={LARGE_HTTP_ORIGIN:'https://router.example',LARGE_HTTP_TOKEN:'a'.repeat(64),LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_RUNTIME_BYTES:'100'};
 const first=await runtimeConfig(env);
 for(const field of ['OPENROUTER_API_KEY','AZURE_OPENAI_ENDPOINT','MODEL_API_KEY']){
  const next=await runtimeConfig({...env,[field]:'fixture-value'});assert.notEqual(next.fingerprint,first.fingerprint);assert.equal(JSON.stringify(next).includes('fixture-value'),false);
 }
 assert.equal((await runtimeConfig({...env,ANTHROPIC_API_KEY:'fixture-unrelated'})).fingerprint,first.fingerprint);
});
test('ingress-only release versions have identical native settings and fingerprints',async()=>{
 const env={LARGE_HTTP_ORIGIN:'https://router.example',LARGE_HTTP_TOKEN:'a'.repeat(64),LARGE_HTTP_RUNTIME_SHA:'b'.repeat(64),LARGE_HTTP_RUNTIME_BYTES:'100'};
 const normal=await runtimeConfig(env);
 for(const flag of ['0','1'])assert.deepEqual(await runtimeConfig({...env,LARGE_HTTP_INGRESS_ENABLED:flag}),normal);
 assert.equal(normal.enabled,true);assert.equal(runtimeFields.includes('LARGE_HTTP_INGRESS_ENABLED'),false);
 assert.equal((await runtimeConfig({...env,LARGE_HTTP_ENABLED:'0'})).enabled,false);
});
