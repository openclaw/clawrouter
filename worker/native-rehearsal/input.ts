import {createJsonTokenizer} from '../json-tokens.ts';
// Observe only bounded synthetic directives in Responses input text. Drain large
// strings without materializing them; never store the request or other content.
// The unmodified native ingress enforces 64 MiB. Allow 1 MiB of provider
// transform overhead here (e.g. inserted store:false), not a larger client body.
export async function inspectSyntheticInput(r:Request){
 let depth=0,inputDepth=0,key='',keyText='',value='',inKey=false,inString=false,bytes=0,model='',stream=false;
 const texts:string[]=[];
 const parser=createJsonTokenizer(t=>{
  if(t.name==='startKey'){inKey=true;keyText='';}
  else if(t.name==='endKey'){inKey=false;key=keyText;}
  else if(t.name==='startObject'||t.name==='startArray'){depth++;if(depth>32)throw Error('input_depth');if(depth===2&&key==='input')inputDepth=depth;key='';}
  else if(t.name==='endObject'||t.name==='endArray'){if(depth===inputDepth)inputDepth=0;depth--;key='';}
  else if(t.name==='startString'){inString=true;value='';}
  else if(t.name==='stringChunk'){if(inKey){keyText+=t.value;if(keyText.length>128)throw Error('input_key');}else if(inString)value=(value+t.value.slice(0,512)).slice(0,512);}
  else if(t.name==='endString'){
   if(inputDepth&&key==='text'&&value.startsWith('NATIVE_REHEARSAL_')){texts.push(...value.split('\n').map(t=>t.trim()).filter(t=>t.startsWith('NATIVE_REHEARSAL_')));if(texts.length>64)throw Error('input_count');}
   if(depth===1&&key==='model')model=value;
   inString=false;key='';
  }else if(t.name==='trueValue'||t.name==='falseValue'){if(depth===1&&key==='stream')stream=t.name==='trueValue';key='';}
 });
 if(!r.body)throw Error('input_empty');const reader=r.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 try{for(;;){const n=await reader.read();if(n.done)break;bytes+=n.value.byteLength;if(bytes>65*1024*1024)throw Error('input_limit');
 // Bound token vectors independently of the incoming stream's chunk size.
 for(let i=0;i<n.value.length;i+=16384)parser.push(decoder.decode(n.value.subarray(i,i+16384),{stream:true}));
 }parser.push(decoder.decode());parser.end();}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const seeds=[...new Set(texts.flatMap(t=>/^NATIVE_REHEARSAL_SEED:([a-f0-9]{64})$/.exec(t)?.[1]??[]))];
 const command=/^NATIVE_REHEARSAL_CASE:([a-f0-9]{32}):(seed|hold|recall|success|reject|lost|max):(forward|recovery|baseline)$/.exec(texts.at(-1)??'');
 if(seeds.length!==1||!command||model!=='gpt-6-astra')throw Error('input_context');
 return {seed:seeds[0],id:command[1],mode:command[2],direction:command[3],model,stream,bytes};
}
