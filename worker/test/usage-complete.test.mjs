import assert from 'node:assert/strict';
import test from 'node:test';
import {completeFixture,complete} from './usage-complete-fixture.mjs';

test('literal totals, day buckets, complete groups/remainder and all accounting presence fields reconcile',async t=>{
 const f=await completeFixture(t);
 await f.ingest(0,f.event('a',{input_tokens:10,output_tokens:4,cached_input_tokens:2,cache_write_input_tokens:3,reasoning_output_tokens:1,actual_cost_micros:20,model:'alpha'}));
 await f.ingest(1,f.event('b',{input_tokens:0,output_tokens:0,actual_cost_micros:0,cost_basis:'unpriced_usage',model:'beta',status:'denied',request_format:'openai.models',grant_lane:'subscription'}));
 const r=complete(await f.read());assert.equal(r.cut,null);assert.equal(r.metrics.calls,2);assert.equal(r.metrics.inputTokens,10);assert.equal(r.metrics.outputTokens,4);assert.equal(r.metrics.cachedInputTokens,2);assert.equal(r.metrics.cacheWriteInputTokens,3);assert.equal(r.metrics.reasoningOutputTokens,1);
 assert.equal(r.metrics.inputReportedCalls,2);assert.equal(r.metrics.cacheReadReportedCalls,1);assert.equal(r.metrics.utilityCalls,1);assert.equal(r.metrics.deniedCalls,1);assert.equal(r.recordedChargeMicros,20);assert.equal(r.chargeReportedCalls,2);
 assert.deepEqual(r.costs,[{lane:'api',costClass:'calculated',calls:1,amountMicros:20},{lane:'subscription',costClass:'unknown',calls:1,amountMicros:0}]);
 assert.equal(r.rank.distinctGroups,2);assert.equal(r.remainder.metrics.calls,0);assert.equal(r.buckets.reduce((s,b)=>s+b.metrics.calls,0),2);
 assert.equal(r.coverage.historicalLocations,'not_exhaustively_assessed');assert.equal(r.coverage.formerLocationLateWrites,'not_bounded');assert.equal(f.owner.usageCuts,undefined);
 const exported=complete(await f.export());assert.equal(exported.events.length,2);assert.deepEqual(exported.report.metrics,r.metrics);
});

test('more than 2048 groups: global winner absent local top100; exact ranks and remainder',async t=>{
 const f=await completeFixture(t);const start=performance.now();
 for(let shard=0;shard<2;shard++){
  for(let i=0;i<1100;i++)await f.ingest(shard,f.event('local-'+i,{model:'s'+shard+'-'+String(i).padStart(4,'0')}));
  for(let i=0;i<102;i++)await f.ingest(shard,f.event('popular-'+i,{model:'local-popular-'+shard+'-'+i}));
  // Each local competitor has four rows, but shared winner has 3+3=6.
  for(let i=0;i<102;i++)for(let j=0;j<3;j++)await f.ingest(shard,f.event('popular-extra-'+i+'-'+j,{model:'local-popular-'+shard+'-'+i}));
  for(let j=0;j<3;j++)await f.ingest(shard,f.event('winner-'+j,{model:'winner'}));
 }
 const r=complete(await f.read({intent:'browse'}));assert.equal(r.rank.distinctGroups,2405);assert.equal(r.groups[0].identity.value,'winner');assert.equal(r.groups[0].metrics.calls,6);assert.equal(r.metrics.calls,3022);assert.equal(r.groups.length,100);assert.equal(r.remainder.metrics.calls,2620);
 const second=complete(await f.continuation({kind:'report',intent:'browse',cut:r.cut,query:{...r.query,rankOffset:100}}));
 assert.equal(second.groups.length,100);assert.equal(second.groups[0].metrics.calls,4);assert.equal(second.rank.exact,true);assert.equal(second.remainder.metrics.calls,2622);
 t.diagnostic(JSON.stringify({groups:2405,rows:3022,elapsedMs:Math.round(performance.now()-start),privateCalls:f.calls.filter(c=>c.path==='/complete-usage').length,peakFanout:f.peak}));
});

test('typed null, BINARY astral ties and retained owner distinguish identical key IDs',async t=>{
 const f=await completeFixture(t,1);
 for(const [id,principal,key,model]of [['1','alice@example.com',null,''],['2','alice@example.com','null','😀'],['3','bob@example.com','same','😀'],['4','alice@example.com','same',null]])await f.ingest(0,f.event(id,{principal_id:principal,credential_id:key,model}));
 const keys=complete(await f.read({query:{...f.query,groupBy:'key'}}));assert.deepEqual(keys.groups.map(g=>g.identity),[{owner:'alice@example.com',value:null},{owner:'alice@example.com',value:'null'},{owner:'alice@example.com',value:'same'},{owner:'bob@example.com',value:'same'}]);
 const models=complete(await f.read());assert.deepEqual(models.groups.map(g=>g.identity.value),['😀',null,'']);
 const session=complete(await f.read({query:{...f.query,filters:{key:{kind:'session'}}}}));assert.equal(session.metrics.calls,1);
 const user=complete(await f.read({query:{...f.query,groupBy:'user'}}));assert.deepEqual(user.groups.map(g=>[g.identity.value,g.metrics.calls]),[['alice@example.com',3],['bob@example.com',1]]);
});

test('event cursor keeps equal ID/time cross-shard rows and deterministic retries, rejects refinements',async t=>{
 const f=await completeFixture(t);for(let s=0;s<2;s++)for(const id of ['z','é','😀'])await f.ingest(s,f.event(id));
 const r=complete(await f.read({intent:'browse'})),request={kind:'events',cut:r.cut,query:r.query,pageSize:1};
 let page=complete(await f.continuation(request)),cursor=page.nextCursor;assert.equal(page.events[0].id,'😀');
 const retry=complete(await f.continuation({...request,cursor}));assert.equal(retry.events[0].id,'😀');assert.deepEqual(complete(await f.continuation({...request,cursor})),retry);
 assert.equal((await f.continuation({...request,cursor,query:{...r.query,rankBy:'tokens'}})).kind,'restart');
 const ids=[page.events[0].id];while(cursor){page=complete(await f.continuation({...request,cursor}));ids.push(...page.events.map(e=>e.id));cursor=page.nextCursor;}
 assert.deepEqual(ids,['😀','😀','é','é','z','z']);
});

test('late paired inserts excluded, fresh export independent, empty shard destructive mutation restarts',async t=>{
 const f=await completeFixture(t);await f.ingest(0,f.event('before'));
 const r=complete(await f.read({intent:'browse'}));await f.ingest(0,f.event('late',{occurred_at_ms:f.now-5000}));
 assert.equal(complete(await f.continuation({kind:'report',intent:'browse',cut:r.cut,query:r.query})).metrics.calls,1);
 assert.equal(complete(await f.export(r.query)).events.length,2);
 // Empty contributing shard still validates source and visibility.
 const empty=[...f.shards.values()][1];empty.sql.exec('UPDATE usage_report_visibility SET epoch=lower(hex(randomblob(16)))');
 assert.equal((await f.continuation({kind:'events',cut:r.cut,query:r.query})).kind,'restart');
});

test('retained v1 fallback preserves missing recorded amount; pinned source never upgrades mid-cut',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('missing'));await f.ingest(0,f.event('zero',{actual_cost_micros:0,cost_basis:'unpriced_usage'}));
 const shard=[...f.shards.values()][0];shard.sql.exec("UPDATE usage_events SET event_json=json_remove(event_json,'$.actual_cost_micros','$.input_tokens') WHERE id='missing'");
 const retained=complete(await f.read({intent:'browse'}));assert.equal(retained.metrics.calls,2);assert.equal(retained.chargeReportedCalls,1);assert.equal(retained.recordedChargeMicros,0);assert.equal(retained.metrics.inputReportedCalls,1);
 const root=[...f.owner.usageCuts.roots.values()][0];assert.equal(root.capture.vector[0].cut.source,'retained_ledger');
 const exported=complete(await f.export());assert.equal(exported.events.find(e=>e.id==='missing').recordedChargeMicros,null);assert.equal(exported.events.find(e=>e.id==='zero').recordedChargeMicros,0);
 const {migrateUsageReport}=await import('../usage-report-store.ts');migrateUsageReport(shard.sql,shard.transactionSync,{apply:true,now:f.now});
 assert.equal(complete(await f.continuation({kind:'report',intent:'browse',cut:retained.cut,query:retained.query})).chargeReportedCalls,1);
 assert.equal(root.capture.vector[0].cut.source,'retained_ledger');
 const projected=complete(await f.read({intent:'browse'}));shard.sql.exec("UPDATE usage_report_events SET report_format_version=1 WHERE id='zero'");
 assert.equal((await f.continuation({kind:'events',cut:projected.cut,query:projected.query})).kind,'restart');
 const v1=complete(await f.read({intent:'browse'}));assert.equal([...f.owner.usageCuts.roots.values()].find(r=>r.handle===v1.cut).capture.vector[0].cut.source,'retained_ledger');
});

test('all shards share strict common floor, outside-retention is not a zero, forward jump restarts',async t=>{
 const f=await completeFixture(t);const shards=[...f.shards.values()],old=f.now-30*86400000;
 shards[1].sql.exec('UPDATE usage_report_visibility SET observed_clock=?',f.now+60000);
 await f.ingest(0,f.event('clipped',{occurred_at_ms:old+910000}));await f.ingest(0,f.event('visible',{occurred_at_ms:old+1000000}));
 const r=complete(await f.read({intent:'browse',query:{...f.query,from:old}}));
 assert.equal(r.query.from,f.now+60000-30*86400000+900000);assert.equal(r.coverage.clippedFrom,old);assert.equal(r.metrics.calls,1);assert.equal(r.buckets[0].start,r.query.from);
 assert.equal((await f.read({query:{...f.query,from:old,to:old+100}})).kind,'outside_retained_range');
 shards[0].sql.exec('UPDATE usage_report_visibility SET retention_cutoff=?',r.query.from+1);
 assert.equal((await f.continuation({kind:'events',cut:r.cut,query:r.query})).kind,'restart');
});

test('personal resolves current authority internally, excludes foreign owner and reports no access',async t=>{
 const f=await completeFixture(t);await f.ingest(0,f.event('mine'));await f.ingest(0,f.event('foreign',{principal_id:'bob@example.com'}));await f.ingest(1,f.event('other-policy'));
 await f.personal();const r=complete(await f.read({intent:'browse'}));assert.equal(r.metrics.calls,1);assert.equal(r.coverage.scope,'personal_current_access');assert.equal(r.query.filters.user,'alice@example.com');
 assert.equal(f.calls.some(c=>c.path==='/usage-inventory'),false);
 await assert.rejects(f.read({query:{...f.query,filters:{user:'bob@example.com'}}}),/personal owner/);
 // Real authority policy disable invalidates existing capabilities, even with same session proof.
 await f.direct('/policies/put',{policyId:'p0',policy:{tenantId:'tenant',enabled:false,providers:[]}});
 assert.equal((await f.continuation({kind:'events',cut:r.cut,query:r.query})).kind,'no_access');
});

test('retired inventory, capture-evidence and final whole-vector mutations cannot publish success',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('old'));
 const moved=f.addShard('new','p0');await f.direct('/policies/put',{policyId:'p0',policy:{tenantId:'new',enabled:true,providers:[]}});await f.ingest(moved,f.event('new'));
 const r=complete(await f.read({intent:'browse'}));assert.equal(r.metrics.calls,2);
 f.authority.sql.exec('DROP TRIGGER usage_inventory_update_v1');assert.equal((await f.continuation({kind:'events',cut:r.cut,query:r.query})).kind,'restart');
 let changed=false;f.hook=(call,response)=>{if(!changed&&call.body.action==='groups'){changed=true;[...f.shards.values()][0].sql.exec("UPDATE usage_events SET status='denied' WHERE id='old'");}return response;};
 assert.equal((await f.read({intent:'browse'})).kind,'restart');assert.ok([...f.owner.usageCuts.roots.values()].every(r=>r.capture!==null));
 f.hook=undefined;const fresh=complete(await f.read({intent:'browse'}));
 f.authority.sql.exec('UPDATE usage_shard_retired SET retired_at_ms=?',Date.now()-30*86400000);
 assert.equal((await f.continuation({kind:'events',cut:fresh.cut,query:fresh.query})).kind,'restart');
});

test('twenty minutes of summary cadence allocates zero roots; browse churn cannot evict exports',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('one'));
 t.mock.timers.enable({apis:['Date'],now:f.now});
 for(let i=0;i<41;i++){t.mock.timers.setTime(f.now+i*30000);assert.equal(complete(await f.read()).cut,null);}
 assert.equal(f.owner.usageCuts,undefined);
 const exp=complete(await f.read({intent:'export'})),other=complete(await f.read({intent:'export'}));
 for(let i=0;i<6;i++)complete(await f.read({intent:'browse'}));
 assert.equal(f.owner.usageCuts.roots.size,4);assert.equal(complete(await f.continuation({kind:'validate',cut:exp.cut,query:exp.query})).valid,true);
 assert.equal((await f.read({intent:'export'})).reason,'capacity');
 const calls=f.calls.length;await assert.rejects(f.read({cut:other.cut}),/intent/);assert.equal(f.calls.length,calls);
 assert.equal(complete(await f.continuation({kind:'release',cut:exp.cut,query:exp.query})).released,true);assert.equal(complete(await f.continuation({kind:'release',cut:exp.cut,query:exp.query})).released,true);
});

test('cancel/outage releases pending, never partial; uncertain finalize observes same operation',async t=>{
 const f=await completeFixture(t);await f.ingest(0,f.event('one'));const abort=new AbortController();
 f.hook=(call,response)=>{if(call.body.action==='groups')abort.abort();return response;};
 assert.equal((await f.read({intent:'browse'},abort.signal)).kind,'unavailable');assert.equal(f.owner.usageCuts.roots.size,0);
 f.hook=(call,response)=>{if(call.body.action==='capture'&&call.name.endsWith(':p1'))throw Error('fixture outage');return response;};
 assert.equal((await f.read({intent:'browse'})).kind,'unavailable');assert.equal(f.owner.usageCuts.roots.size,0);
 let uncertain=true;f.hook=(call,response)=>{if(uncertain&&call.path==='/usage-cuts/finalize'){uncertain=false;throw Error('lost receipt');}return response;};
 const r=complete(await f.read({intent:'browse'}));assert.equal(r.metrics.calls,1);assert.equal(f.calls.filter(c=>c.path==='/usage-cuts/observe').length,1);assert.equal(f.owner.usageCuts.roots.size,1);
});

test('disabled visibility maintenance commits drain on unavailable reads; attribution migration is unavailable',async t=>{
 const f=await completeFixture(t,1),s=[...f.shards.values()][0];for(let i=0;i<1001;i++)await f.ingest(0,f.event('r'+i));
 s.sql.exec('UPDATE usage_report_visibility SET usable=0');
 assert.deepEqual(await f.read(),{kind:'unavailable',reason:'capacity'});assert.equal(s.sql.exec('SELECT COUNT(*) AS n FROM usage_report_arrivals')[0].n,1);
 assert.equal(complete(await f.read()).metrics.calls,1001);
 s.sql.exec('UPDATE usage_attribution_migration SET complete=0');assert.deepEqual(await f.read(),{kind:'unavailable',reason:'migration'});
});

test('checked sums and oversized event metadata fail whole rather than truncating',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('a',{input_tokens:Number.MAX_SAFE_INTEGER}));await f.ingest(0,f.event('b'));
 assert.equal((await f.read()).kind,'unavailable');
 const g=await completeFixture(t,1);await g.ingest(0,g.event('huge',{compound_request_id:'x'.repeat(1024*1024)}));
 const r=complete(await g.read({intent:'browse'}));assert.equal((await g.continuation({kind:'events',cut:r.cut,query:r.query})).reason,'capacity');assert.equal((await g.export()).kind,'unavailable');
});

test('elapsed deadline stops new work even when synchronous SQL starves the timeout callback',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('one'));let clock=0;t.mock.method(performance,'now',()=>clock);
 f.hook=(call,response)=>{if(call.body.action==='groups')clock=20000;return response;};
 assert.deepEqual(await f.read({intent:'browse'}),{kind:'unavailable',reason:'cancelled'});assert.equal(f.calls.some(c=>c.body.action==='validate'),false);assert.equal(f.owner.usageCuts.roots.size,0);
});

test('cursor ring binds grain/timezone/rank offset/page size; base reset only, widening rejected',async t=>{
 const f=await completeFixture(t,1);for(let i=0;i<12;i++)await f.ingest(0,f.event(String(i).padStart(2,'0'),{model:i%2?'a':'b'}));
 const base=complete(await f.read({intent:'browse'}));let page=complete(await f.continuation({kind:'events',cut:base.cut,query:base.query,pageSize:1})),first=page.nextCursor;
 for(const patch of [{grain:'minute'},{timezone:'America/New_York'},{rankOffset:1}])assert.equal((await f.continuation({kind:'events',cut:base.cut,query:{...base.query,...patch},pageSize:1,cursor:first})).kind,'restart');
 assert.equal((await f.continuation({kind:'events',cut:base.cut,query:base.query,pageSize:2,cursor:first})).kind,'restart');
 for(let i=0;i<8;i++)page=complete(await f.continuation({kind:'events',cut:base.cut,query:base.query,pageSize:1,cursor:page.nextCursor}));
 assert.equal((await f.continuation({kind:'events',cut:base.cut,query:base.query,pageSize:1,cursor:first})).kind,'restart');
 const narrow=complete(await f.continuation({kind:'report',intent:'browse',cut:base.cut,query:{...base.query,grain:'minute',filters:{model:'a'}}}));assert.equal(narrow.metrics.calls,6);assert.equal(narrow.buckets.reduce((n,b)=>n+b.metrics.calls,0),6);
 assert.equal(complete(await f.continuation({kind:'report',intent:'browse',cut:base.cut,query:base.query})).metrics.calls,12);
 assert.equal((await f.continuation({kind:'report',intent:'browse',cut:base.cut,query:{...base.query,from:base.query.from-1}})).kind,'restart');
});

test('full export independently reconciles every present count, amount, lane/class, status and call kind',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('zero',{input_tokens:0,output_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0,actual_cost_micros:0,cost_basis:'none'}));
 const patches=[...['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','recordedChargeMicros'].map(k=>({[k]:null})),{inputTokens:1},{outputTokens:1},{cachedInputTokens:1},{cacheWriteInputTokens:1},{reasoningOutputTokens:1},{recordedChargeMicros:1},{reportingCostMicros:1},{lane:'subscription'},{costClass:'fixed'},{status:'denied'},{status:'server_error'},{callKind:'utility'}];
 for(const patch of patches){let corrupted=false;f.hook=async(call,response)=>{if(call.body.action==='events'&&!corrupted){corrupted=true;const body=await response.json();Object.assign(body.value.events[0],patch);return Response.json(body);}return response;};
  assert.deepEqual(await f.export(),{kind:'unavailable',reason:'source'},JSON.stringify(patch));assert.equal(f.owner.usageCuts.roots.size,0);}
 f.hook=undefined;assert.equal(complete(await f.export()).events.length,1);
});

test('final authority expansion/session refresh and final export mutation cannot publish',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('one'));let changed=false;
 f.hook=async(call,response)=>{if(call.body.action==='groups'&&!changed){changed=true;await f.direct('/policies/put',{policyId:'new',policy:{tenantId:'tenant'}});}return response;};
 assert.deepEqual(await f.read({intent:'browse'}),{kind:'restart',reason:'authority'});assert.equal(f.owner.usageCuts.roots.size,0);
 f.hook=undefined;f.addShard('tenant','new');const base=complete(await f.read({intent:'browse'}));f.caller={...f.caller,sessionBinding:'c'.repeat(64)};
 assert.equal((await f.continuation({kind:'events',cut:base.cut,query:base.query})).kind,'restart');
 let mutate=false;f.hook=(call,response)=>{if(call.body.action==='events'&&!mutate){mutate=true;[...f.shards.values()][0].sql.exec("DELETE FROM usage_events WHERE id='one'");}return response;};
 assert.equal((await f.export()).kind,'restart');
});

test('summary rejects even empty handles before I/O; omitted rank offset has canonical continuation identity',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('one'));const before=f.calls.length;
 for(const field of ['cut','cursor'])await assert.rejects(f.read({[field]:''}),/opaque/);
 assert.equal(f.calls.length,before);assert.equal(f.owner.usageCuts,undefined);
 const query={...f.query};delete query.rankOffset;const r=complete(await f.read({intent:'browse',query}));assert.equal(r.query.rankOffset,0);
 assert.equal(complete(await f.continuation({kind:'events',cut:r.cut,query})).events.length,1);
});

test('malformed stored detail fails whole, while unlisted raw fields never escape',async t=>{
 const f=await completeFixture(t,1);await f.ingest(0,f.event('one'));const s=[...f.shards.values()][0];
 s.sql.exec("UPDATE usage_report_events SET detail_json=json_set(detail_json,'$.raw_prompt','private fixture') WHERE id='one'");
 const r=complete(await f.read({intent:'browse'}));assert.equal(JSON.stringify(complete(await f.continuation({kind:'events',cut:r.cut,query:r.query}))).includes('private fixture'),false);
 s.sql.exec("UPDATE usage_report_events SET detail_json=json_set(detail_json,'$.inputTokens','not numeric') WHERE id='one'");
 assert.equal((await f.continuation({kind:'events',cut:r.cut,query:r.query})).kind,'unavailable');assert.equal((await f.export()).kind,'unavailable');
});
