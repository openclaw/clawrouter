import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompleteUsageQuery, CompleteUsageReport, CompleteUsageEvents, CompleteUsageOutcome } from '../../../shared/usage-report';
import type { ConsoleRequest } from '../dashboard-fetch';
import type { CapturedSessionScope } from '../session-scope';
import { emptyFilters, type PersonalUsageQuery } from '../personal-usage';
import { parseUsageRangeInput, type UsageRangeInput } from '../usage-range';
import { completeQueryString, completeValue, downloadUsageFile, exportRefreshedUsage, releaseUsage, usageEndpoint, usageQueryTemplate, type UsageQueryTemplate, type UsageAudience } from '../complete-usage';
import type { PersonalUsageView } from '../personal-usage-view';
function rangeControls(query:Pick<CompleteUsageQuery,'from'|'to'|'timezone'>):UsageRangeInput{return {from:new Date(query.from).toISOString(),to:new Date(query.to).toISOString(),timezone:query.timezone};}
interface ReadState<T> { key:string; value?:T; loading:boolean; error:string; state?:string }
export interface UsageHookOptions {request:ConsoleRequest;scope:CapturedSessionScope;active:boolean;full:boolean}
/** Shared computation, instance-owned caches. Admin and personal never share roots/data. */
export function useUsageReport({request,scope,active,full}:UsageHookOptions,audience:UsageAudience) {
  const [selection,setSelection]=useState<{query?:CompleteUsageQuery;days:7|30;cut?:string;presetQuery?:UsageQueryTemplate;rangeInput?:UsageRangeInput}>({days:7});
  const [rangeError,setRangeError]=useState('');
  const [revision,setRevision]=useState(0),[eventsRevision,setEventsRevision]=useState(0),[eventsShown,showEvents]=useState(false);
  const [report,setReport]=useState<ReadState<CompleteUsageReport>>({key:'',loading:false,error:''});
  const [events,setEvents]=useState<ReadState<CompleteUsageEvents>>({key:'',loading:false,error:''});
  const [page,setPage]=useState({cursor:null as string|null,previous:[] as Array<string|null>,number:1});
  const [exportState,setExportState]=useState<{key:string;busy:boolean;message:string;report?:CompleteUsageReport}>({key:'',busy:false,message:''});
  const lifetime=useRef(0),lastReport=useRef<CompleteUsageReport|undefined>(undefined),baseInput=useRef<UsageRangeInput|undefined>(undefined);
  const roots=useRef(new Set<string>()),cache=useRef(new Map<string,CompleteUsageReport>()),pages=useRef(new Map<string,CompleteUsageEvents>()),exportController=useRef<AbortController|null>(null),base=useRef<CompleteUsageQuery|null>(null);
  const scopeKey=JSON.stringify([audience,scope.origin,scope.epoch,scope.session.auth,scope.session.role,scope.session.email,scope.session.subject,scope.session.tenantId]);
  const params=selection.query?completeQueryString(selection.query,audience,selection.cut?undefined:selection.rangeInput):new URLSearchParams({days:String(selection.days),groupBy:audience==='admin'?'user':'model'});
  if(!selection.query&&selection.presetQuery){const exact=completeQueryString({...selection.presetQuery,from:0,to:0},audience);for(const [key,value]of exact)if(key!=='from'&&key!=='to')params.set(key,value);}
  params.set('intent',full?'browse':'summary');if(full&&selection.cut)params.set('cut',selection.cut);
  const queryKey=scopeKey+':'+params.toString()+':'+revision,endpoint=usageEndpoint(audience);
  const visible=rangeError?{key:queryKey,loading:false,error:rangeError,state:'invalid_range'}:report.key===queryKey&&scope.isCurrent()?report:{key:queryKey,loading:active,error:''};
  useEffect(()=>{
    // Retire navigation/auth lifetime, not each refinement. Cleanup uses captured origin.
    cache.current.clear();pages.current.clear();base.current=null;baseInput.current=undefined;lastReport.current=undefined;setSelection({days:7});setRangeError('');setReport({key:'',loading:false,error:''});setEvents({key:'',loading:false,error:''});setExportState({key:scopeKey,busy:false,message:''});
    return ()=>{lifetime.current++;for(const cut of roots.current)void releaseUsage(request,scope.origin,audience,cut);roots.current.clear();cache.current.clear();pages.current.clear();exportController.current?.abort();exportController.current=null;};
  },[scopeKey,active,full]);
  useEffect(()=>{
    if(!active||rangeError)return;
    const controller=new AbortController();let current=true;
    const publish=()=>current&&!controller.signal.aborted&&scope.isCurrent();
    if(scope.demo){setReport({key:queryKey,loading:false,error:'Usage reporting is not connected in demo mode. No live usage is shown.'});return;}
    const cached=cache.current.get(queryKey);
    if(cached){setReport({key:queryKey,value:cached,loading:false,error:''});return;}
    setReport(old=>({key:queryKey,loading:true,error:'',...(old.key===queryKey?{value:old.value}:{})}));
    // Coalesce rapid preset/filter changes before allocating a retained root.
    const timer=setTimeout(()=>{void request<CompleteUsageOutcome<CompleteUsageReport>>(scope.origin,endpoint+'/report?'+params,{signal:controller.signal}).then(outcome=>{
      if(outcome.kind==='complete'&&outcome.value.cut&&!publish()){void releaseUsage(request,scope.origin,audience,outcome.value.cut);return;}
      if(!publish())return;
      if(outcome.kind!=='complete'){setReport({key:queryKey,loading:false,error:outcome.kind==='no_access'?'No current access':outcome.kind==='outside_retained_range'?'Outside retained range':'Usage unavailable',state:outcome.kind});return;}
      const value=outcome.value;lastReport.current=value;
      if(value.cut){roots.current.add(value.cut);if(!selection.cut){for(const old of roots.current)if(old!==value.cut){void releaseUsage(request,scope.origin,audience,old);roots.current.delete(old);}base.current=value.query;baseInput.current=selection.rangeInput??rangeControls({...value.query,from:selection.query?.from??value.coverage.clippedFrom??value.query.from});cache.current.clear();}}
      if(cache.current.size>=8)cache.current.delete(cache.current.keys().next().value!);cache.current.set(queryKey,value);
      pages.current.clear();setPage({cursor:null,previous:[],number:1});setReport({key:queryKey,value,loading:false,error:''});
    }).catch(error=>{if(publish())setReport(old=>({key:queryKey,value:old.key===queryKey&&old.value?old.value:lastReport.current,loading:false,error:error instanceof Error?error.message:String(error)}));});},150);
    return ()=>{current=false;clearTimeout(timer);controller.abort();};
  },[active,queryKey,rangeError]);
  const eventKey=queryKey+':'+(visible.value?.cut??'')+':'+(page.cursor??'');
  useEffect(()=>{
    if(!active||!full||!eventsShown||visible.error||!visible.value?.cut)return;
    const cached=pages.current.get(eventKey);if(cached){setEvents({key:eventKey,value:cached,loading:false,error:''});return;}
    const controller=new AbortController();let current=true;const value=visible.value;
    setEvents({key:eventKey,loading:true,error:''});const p=completeQueryString(value.query,audience);p.set('cut',value.cut!);p.set('limit','100');if(page.cursor)p.set('cursor',page.cursor);
    void request<CompleteUsageOutcome<CompleteUsageEvents>>(scope.origin,endpoint+'/events?'+p,{signal:controller.signal}).then(outcome=>{
      if(!current||!scope.isCurrent())return;const result=completeValue(outcome);if(pages.current.size>=8)pages.current.delete(pages.current.keys().next().value!);pages.current.set(eventKey,result);setEvents({key:eventKey,value:result,loading:false,error:''});
    }).catch(error=>{if(current&&scope.isCurrent())setEvents({key:eventKey,loading:false,error:error instanceof Error?error.message:String(error)});});
    return ()=>{current=false;controller.abort();};
  },[active,full,eventsShown,eventKey,visible.value,visible.error,eventsRevision]);
  function reload(){if(rangeError)return;cache.current.clear();pages.current.clear();setPage({cursor:null,previous:[],number:1});setSelection(s=>({...s,query:s.query&&s.rangeInput?{...s.query,...parseUsageRangeInput(s.rangeInput)}:s.query,cut:undefined}));setRevision(r=>r+1);}
  useEffect(()=>{if(!active||full||scope.demo)return;const timer=setInterval(()=>{if(scope.isCurrent()&&(typeof document==='undefined'||document.visibilityState==='visible')){setSelection(s=>({days:s.days,presetQuery:s.presetQuery}));setRevision(r=>r+1);}},30000);return ()=>clearInterval(timer);},[active,full,scopeKey]);
  function refine(query:CompleteUsageQuery,rangeInput?:UsageRangeInput){
    if(visible.error||!visible.value?.cut)return;
    const root=base.current;
    const widened=root&&(query.from<root.from||query.to>root.to||Object.entries(root.filters).some(([key,value])=>!(audience==='personal'&&key==='user')&&JSON.stringify(value)!==JSON.stringify(query.filters[key as keyof typeof query.filters])));
    const sameRange=query.from===visible.value.query.from&&query.to===visible.value.query.to&&query.timezone===visible.value.query.timezone;
    const input=rangeInput??(sameRange?selection.rangeInput??rangeControls(selectedQuery!):rangeControls(query));
    setPage({cursor:null,previous:[],number:1});setSelection(s=>({...s,query:widened?{...query,...parseUsageRangeInput(input)}:query,rangeInput:input,cut:widened?undefined:visible.value!.cut!}));
  }
  function newRange(query:CompleteUsageQuery,rangeInput?:UsageRangeInput){setRangeError('');cache.current.clear();setSelection(s=>({...s,query,rangeInput,cut:undefined}));setRevision(r=>r+1);}
  function customRange(query:UsageQueryTemplate,input:UsageRangeInput,openNew=false){
    let range:{from:number;to:number};
    try{range=parseUsageRangeInput(input);}catch(error){setSelection(s=>({...s,query:undefined,presetQuery:query,rangeInput:input}));setRangeError(error instanceof Error?error.message:String(error));exportController.current?.abort();return;}
    const unchanged=selection.rangeInput&&input.from===selection.rangeInput.from&&input.to===selection.rangeInput.to&&input.timezone===selection.rangeInput.timezone;
    // Controls retain requested bounds; same-cut reads continue at the returned
    // effective bounds, even when the base was partially clipped by retention.
    if(!openNew&&unchanged&&visible.value&&!visible.error)range={from:visible.value.query.from,to:visible.value.query.to};
    const next={...query,...range,timezone:input.timezone,rankOffset:0};
    if(!openNew&&visible.value&&!visible.error)refine(next,input);else newRange(next,input);
  }
  const selectedQuery=useMemo(()=>{
    const value=visible.value;if(!value)return undefined;
    const selected=selection.rangeInput?parseUsageRangeInput(selection.rangeInput):{from:selection.query?.from??value.coverage.clippedFrom??value.query.from,to:selection.query?.to??value.query.to};
    return {...value.query,...selected};
  },[visible.value,selection.query,selection.rangeInput]);
  const shownEvents=events.key===eventKey&&scope.isCurrent()?events:{key:eventKey,loading:active&&eventsShown,error:''};
  const shownExport:typeof exportState=active&&scope.isCurrent()&&exportState.key===scopeKey?exportState:{key:scopeKey,busy:false,message:''};
  async function startExport(format:'csv'|'json'){
    if(!visible.value||!selectedQuery||visible.error||exportController.current)return;const controller=new AbortController(),generation=lifetime.current;const current=()=>generation===lifetime.current&&scope.isCurrent();exportController.current=controller;setExportState({key:scopeKey,busy:true,message:'Capturing refreshed snapshot…'});
    try{const file=await exportRefreshedUsage({request,origin:scope.origin,audience,query:selectedQuery,rangeInput:selection.rangeInput,signal:controller.signal,isCurrent:current,onReport:value=>{if(current()&&!controller.signal.aborted)setExportState({key:scopeKey,busy:true,message:'Reconciling refreshed snapshot; totals may differ from the displayed report.',report:value});}},format);
      if(current()&&!controller.signal.aborted){downloadUsageFile(file);setExportState(s=>({...s,busy:false,message:'Refreshed snapshot downloaded.'}));}
    }catch(error){if(current())setExportState(s=>({...s,busy:false,message:error instanceof Error?error.message:String(error)}));}
    finally{if(exportController.current===controller)exportController.current=null;}
  }
  return {audience,report:visible,events:shownEvents,query:visible.value?.query,requestedQuery:selection.query,queryTemplate:selection.presetQuery,rangeInput:selection.rangeInput,selectedQuery,customRange,refine,reload,showEvents,eventsShown,page:page.number,
    retryEvents:()=>{pages.current.delete(eventKey);setEventsRevision(r=>r+1);},
    rollingDays:selection.query?undefined:selection.days,
    preset:(days:7|30,template?:UsageQueryTemplate)=>{setRangeError('');cache.current.clear();const q=template??visible.value?.query;setSelection({days,presetQuery:q?{...q,grain:'day',rankOffset:0}:undefined});setRevision(r=>r+1);},
    newRange,
    back:()=>{if(base.current)refine(base.current,baseInput.current);},
    nextPage:()=>{if(shownEvents.value?.nextCursor)setPage(p=>({cursor:shownEvents.value!.nextCursor,previous:[...p.previous,p.cursor].slice(-7),number:p.number+1}));},
    previousPage:()=>{if(page.previous.length)setPage(p=>({cursor:p.previous.at(-1)??null,previous:p.previous.slice(0,-1),number:p.number-1}));},canPrevious:page.previous.length>0,
    exportState:shownExport,startExport,cancelExport:()=>exportController.current?.abort()};
}
export type CompleteUsageData=ReturnType<typeof useUsageReport>;
/** Presentation projection only. No additional fetch, authority or aggregate engine. */
export function usePersonalUsage(options:UsageHookOptions){
  const complete=useUsageReport(options,'personal'),v=complete.report.value,q=v?.query??complete.requestedQuery;
  const template=useMemo(()=>q??complete.queryTemplate??usageQueryTemplate('personal'),[q,complete.queryTemplate]);
  const report=useMemo<PersonalUsageView|undefined>(()=>v?{range:{from:v.query.from,to:v.query.to,timezone:v.query.timezone,retentionStart:v.coverage.effectiveFrom,clampedStart:v.coverage.clippedFrom!==null,buckets:v.buckets.map(({start,end,label})=>({start,end,label}))},groupBy:v.query.groupBy as PersonalUsageView['groupBy'],metrics:v.metrics,costs:v.costs,groups:v.groups.map(g=>({value:g.identity.value,metrics:g.metrics,costs:g.costs})),buckets:v.buckets,groupsTruncated:v.rank.distinctGroups>v.groups.length,discoveredScopeAnswered:v.coverage.allDiscoveredSourcesAnswered,generatedAt:v.coverage.capturedBetween.to}:undefined,[v]);
  const query=useMemo<PersonalUsageQuery>(()=>({rollingDays:complete.rollingDays,from:complete.rangeInput?.from??(q?new Date(complete.selectedQuery?.from??q.from).toISOString():''),to:complete.rangeInput?.to??(q?new Date(complete.selectedQuery?.to??q.to).toISOString():''),timezone:complete.rangeInput?.timezone??template.timezone,groupBy:template.groupBy as PersonalUsageQuery['groupBy'],filters:{...emptyFilters,...Object.fromEntries(Object.entries(template.filters).filter(([k])=>k!=='user'&&k!=='key')),key:template.filters.key?.kind==='credential'?template.filters.key.id:''}}),[q,template,complete.rollingDays,complete.rangeInput,complete.selectedQuery]);
  function change(next:PersonalUsageQuery,days?:7|30){
    const filters:CompleteUsageQuery['filters']={};for(const k of ['model','provider','status','costClass','lane'] as const)if(next.filters[k])filters[k]=next.filters[k];if(next.filters.key)filters.key={kind:'credential',id:next.filters.key};else if(template.filters.key?.kind==='session')filters.key={kind:'session'};
    if(days){complete.preset(days,{...template,timezone:next.timezone,groupBy:next.groupBy,filters});return;}
    complete.customRange({...template,groupBy:next.groupBy,filters},{from:next.from,to:next.to,timezone:next.timezone});
  }
  function clearFilters(){complete.customRange({...template,filters:{},rankOffset:0},{from:query.from,to:query.to,timezone:query.timezone},Boolean(complete.report.error));}
  const events:Pick<CompleteUsageEvents,'events'|'nextCursor'>|undefined=complete.events.value?{events:complete.events.value.events,nextCursor:complete.events.value.nextCursor}:undefined;
  return {...complete,complete,query,clearFilters,setQuery:(next:PersonalUsageQuery)=>change(next),choosePreset:(days:7|30,next:PersonalUsageQuery)=>change(next,days),report:{...complete.report,value:report},events:{...complete.events,value:events}};
}
export type PersonalUsageData=ReturnType<typeof usePersonalUsage>;
