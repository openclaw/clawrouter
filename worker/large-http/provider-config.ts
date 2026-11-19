import {snapshot} from '../providers.ts';
import {resolveTemplate} from '../provider-templates.ts';
import type {Env} from '../types.ts';

// Unified Responses selects its provider only after parsing the complete body.
// Mirror just that manifest surface, never the whole deployment environment.
const providers=snapshot.providers.filter(provider=>provider.endpoints.some(endpoint=>
 endpoint.method==='POST'&&endpoint.path_params.length===0&&
 ['openai.responses','openai.responses_compact'].includes(endpoint.request_format)));
export const runtimeFields=[...new Set([
 'LARGE_HTTP_TESTING','CLAWROUTER_CONTENT_RETENTION_DEFAULT','CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS',
 'CLAWROUTER_UPSTREAM_RETENTION_BINDINGS','CLAWROUTER_OPTIONAL_CONFIG_KEYS',
 ...providers.flatMap(provider=>provider.config_keys),
])];

export function runtimeProviderOrigins(env:Env):string[]{
 const origins=new Set<string>();
 for(const provider of providers){
  for(const template of [provider.base_urls.default,...Object.values(provider.auth.grantTransports).map(transport=>transport.baseUrl)]){
   if(typeof template!=='string')continue;
   try{const url=new URL(resolveTemplate(provider,template,env));if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)origins.add(url.origin);}
   // Missing/malformed configuration keeps that destination closed. Canonical
   // selection still returns its own configuration/auth error before dispatch.
   catch{}
  }
 }
 return [...origins];
}
