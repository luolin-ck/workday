import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readCompletion} from '../src/main/network';
import {Store} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {AppService} from '../src/main/service';
import {emptyContext,type Message} from '../src/shared/types';
import {backupSchemas} from '../src/main/backup-schema';
import {MessageMeter,normalizeUsage} from '../src/main/message-metrics';

const event=(value:unknown)=>'data: '+JSON.stringify(value)+'\n\n';
const stop=event({choices:[{delta:{content:'fixture reply'},finish_reason:'stop'}]});
const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:80,cache_write_tokens:5}};
const normalized={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:80,cacheWriteTokens:5};
const stream=(value:unknown=usage)=>new Response(stop+event({choices:[],usage:value})+'data: [DONE]\n\n');
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){
 const dir=await fs.mkdtemp('/private/tmp/workday-metrics-test-'),store=await Store.open(path.join(dir,'workday.sqlite'));
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()});await credentials.init();let backupFile:string|null=null;
 const dialogs={openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>backupFile,openBackup:async()=>backupFile,openExternal:async()=>{},openDirectory:async()=>{}};
 const service=new AppService(store,credentials,dialogs,dir);cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 const source=await service.call('sources.save',{name:'Metrics fixture',baseUrl:'https://metrics-fixture.invalid/v1',models:[{id:'fixture',name:'Fixture',supportsTools:true}]});
 const model={sourceId:source.id,modelId:'fixture'},conversation=await service.call('conversations.create',{projectId:null,date:null,model});
 const terminal=()=>new Promise<string>(resolve=>{const off=service.subscribe(e=>{if(['chatDone','chatFailed','chatCancelled'].includes(e.type)){off();resolve(e.type);}});});
 const send=async(context=emptyContext(),text='metrics fixture')=>{const done=terminal();const sent=await service.call('chat.send',{conversationId:conversation.id,text,model,context});return{...sent,done};};
 const assistant=()=>store.list<Message>('messages').filter(m=>m.role==='assistant').at(-1)!;
 return{dir,store,service,credentials,dialogs,source,model,conversation,terminal,send,assistant,setBackup:(file:string)=>backupFile=file};
}

describe('provider usage capture',()=>{
 it('retains trailing empty-choices usage and treats repeated cumulative frames as one snapshot',async()=>{
  const response=new Response(stop+event({choices:[],usage})+event({choices:[],usage})+'data: [DONE]\n\n');
  expect((await readCompletion(response,()=>{}) as any).usage).toEqual(normalized);
 });
 it('preserves valid zero and ignores invalid fields without losing the answer',async()=>{
  const result=await readCompletion(stream({prompt_tokens:0,completion_tokens:-1,total_tokens:1.5,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:Number.MAX_SAFE_INTEGER+1}}),()=>{}) as any;
  expect(result.content).toBe('fixture reply');expect(result.usage).toEqual({inputTokens:0,cachedInputTokens:0});
 });
 it('makes the latest observed usage available when the stream is interrupted',async()=>{
  const observed:unknown[]=[];
  await expect((readCompletion as any)(new Response(event({choices:[],usage})),()=>{},(u:unknown)=>observed.push(u))).rejects.toThrow();
  expect(observed).toEqual([normalized]);
 });
 it('uses the latest cumulative snapshot rather than summing duplicate or updated frames',async()=>{
  const observed:unknown[]=[];const updated={...usage,prompt_tokens:200,total_tokens:220};
  const result=await readCompletion(new Response(stop+event({choices:[],usage})+event({choices:[],usage})+event({choices:[],usage:updated})+'data: [DONE]\n\n'),()=>{},u=>{observed.push(u);});
  expect(result.usage?.inputTokens).toBe(200);expect(observed).toHaveLength(2);
 });
 it('ignores malformed optional usage and does not derive total or cache misses',async()=>{
  for(const value of [null,[],{prompt_tokens:'1'},{prompt_tokens:NaN},'bad'])expect(normalizeUsage(value)).toBeUndefined();
  expect(normalizeUsage({prompt_tokens:4,completion_tokens:2,prompt_tokens_details:{cached_tokens:8}})).toEqual({inputTokens:4,outputTokens:2});
 });
 it('captures usage split across arbitrary transport chunks',async()=>{
  const bytes=new TextEncoder().encode(stop+event({choices:[],usage})+'data: [DONE]\n\n');const response=new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}));expect((await readCompletion(response,()=>{})).usage).toEqual(normalized);
 });
});

describe('meter boundaries',()=>{
 it('uses monotonic duration despite wall-clock rollback and finalizes once',()=>{
  let now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);vi.useFakeTimers({toFake:['Date']});
  try{vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));const meter=new MessageMeter();now=1210;vi.setSystemTime(new Date('2026-10-27T09:00:00Z'));meter.finish();const ended=meter.snapshot();expect(ended.durationMs).toBe(1110);expect(ended.completedAt).toBe('2026-10-27T09:00:00.000Z');now=9000;meter.finish();expect(meter.snapshot()).toEqual(ended);}finally{vi.useRealTimers();}
 });
 it('preserves independent field coverage with missing whole rounds and safely omits overflow',()=>{
  const meter=new MessageMeter();meter.beginRound();meter.observe({inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:0});meter.completeRound();meter.beginRound();meter.completeRound();meter.beginRound();meter.observe({inputTokens:1,totalTokens:2});meter.completeRound();meter.finish();
  expect(meter.snapshot()).toMatchObject({rounds:3,completedRounds:3,usage:{outputTokens:0,totalTokens:2},reportedRounds:{outputTokens:1,totalTokens:1}});expect(meter.snapshot().usage?.inputTokens).toBeUndefined();expect(meter.snapshot().reportedRounds?.inputTokens).toBeUndefined();
 });
});

describe('message metrics lifecycle',()=>{
 it('finishes a provider response with no usage without inventing token counters',async()=>{
  const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response(stop+'data: [DONE]\n\n')));const sent=await f.send();expect(await sent.done).toBe('chatDone');const m=f.assistant();expect(m.content).toBe('fixture reply');expect(m.metrics).toMatchObject({rounds:1,completedRounds:1});expect(m.metrics?.durationMs).toBeGreaterThanOrEqual(0);expect(m.metrics?.usage).toBeUndefined();expect(m.metrics?.reportedRounds).toBeUndefined();
 });
 it('continues with unavailable usage after one explicitly rejected usage option',async()=>{
  const f=await fixture();let count=0;const fetch=vi.fn(async()=>++count===1?new Response(JSON.stringify({error:{param:'stream_options.include_usage',message:'not supported'}}),{status:422}):new Response(stop+'data: [DONE]\n\n'));vi.stubGlobal('fetch',fetch);const sent=await f.send();expect(await sent.done).toBe('chatDone');expect(fetch).toHaveBeenCalledTimes(2);expect(f.assistant().metrics).toMatchObject({rounds:1,completedRounds:1});expect(f.assistant().metrics?.usage).toBeUndefined();
 });
 it.each(['complete','failed'] as const)('records image %s duration without invented text-model usage',async outcome=>{
  const f=await fixture();vi.spyOn(f.service.images,'run').mockImplementation(async id=>{await new Promise(r=>setTimeout(r,20));if(outcome==='failed')throw new Error('fixture image error');return{...await f.service.images.load(id),stage:'complete',generation:'complete',media:[]};});const fetch=vi.fn(async()=>{throw new Error('image must not call text backend');});vi.stubGlobal('fetch',fetch);
  const sent=await f.send(emptyContext(),'使用生图，生成24帧，最后拼成一个gif动图');expect(await sent.done).toBe(outcome==='complete'?'chatDone':'chatFailed');const m=f.assistant();expect(m.metrics).toMatchObject({rounds:0,completedRounds:0});expect(m.metrics?.durationMs).toBeGreaterThanOrEqual(15);expect(m.metrics?.completedAt).toBeTruthy();expect(m.metrics?.usage).toBeUndefined();expect(fetch).not.toHaveBeenCalled();
 });
 it('persists actual completion time, duration and provider usage; backup restore preserves it independently of requests',async()=>{
  const f=await fixture(),fetch=vi.fn(async(_url:string,init:RequestInit)=>{expect(JSON.parse(init.body as string).stream_options).toEqual({include_usage:true});await new Promise(r=>setTimeout(r,20));return stream();});vi.stubGlobal('fetch',fetch);
  const sent=await f.send();expect(await sent.done).toBe('chatDone');const m=f.assistant() as any;
  expect(m.metrics).toMatchObject({rounds:1,completedRounds:1,usage:normalized,reportedRounds:{inputTokens:1,outputTokens:1,totalTokens:1,cachedInputTokens:1,cacheWriteTokens:1}});
  expect(m.metrics.durationMs).toBeGreaterThanOrEqual(15);expect(Date.parse(m.metrics.completedAt)).toBeGreaterThanOrEqual(Date.parse(m.metrics.startedAt));
  const backup=await f.service.backup();expect(backup.rows.requests).toEqual([]);const file=path.join(f.dir,'backup.json');f.setBackup(file);await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));
  try{expect(copy.get<any>('messages',m.id).metrics).toEqual(m.metrics);}finally{copy.close();}
 });
 it('retains partial usage on failure and gives retry a fresh meter',async()=>{
  const f=await fixture();let count=0;vi.stubGlobal('fetch',vi.fn(async()=>++count===1?new Response(event({choices:[],usage})):stream({prompt_tokens:3,completion_tokens:2,total_tokens:5})));
  const sent=await f.send();expect(await sent.done).toBe('chatFailed');const failed=f.assistant() as any;
  expect(failed.metrics).toMatchObject({rounds:1,completedRounds:0,usage:normalized});expect(failed.metrics.durationMs).toBeGreaterThanOrEqual(0);
  const done=f.terminal();await f.service.call('chat.retry',{conversationId:f.conversation.id,userMessageId:sent.userMessageId});expect(await done).toBe('chatDone');
  expect((f.assistant() as any).metrics).toMatchObject({rounds:1,completedRounds:1,usage:{inputTokens:3,outputTokens:2,totalTokens:5}});expect((f.assistant() as any).metrics.usage.cachedInputTokens).toBeUndefined();expect(f.store.get<any>('messages',failed.id).metrics).toEqual(failed.metrics);
 });
 it('records elapsed cancellation and marks backup/restart interruption without offline duration',async()=>{
  const f=await fixture();let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
  vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>new Response(new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(new TextEncoder().encode(event({choices:[],usage})));init.signal?.addEventListener('abort',()=>c.error(new Error('aborted')),{once:true});}}))));
  const sent=await f.send();await vi.waitFor(()=>expect((f.assistant() as any).metrics?.usage).toEqual(normalized));
  const backup=await f.service.backup(),saved=backup.rows.messages.find((m:any)=>m.role==='assistant');expect(saved.metrics.interrupted).toBe(true);expect(saved.metrics.durationMs).toBeUndefined();expect(saved.metrics.completedAt).toBeUndefined();
  const file=path.join(f.dir,'crash.sqlite');await fs.copyFile(f.store.file,file);const copy=await Store.open(file),recovered=new AppService(copy,f.credentials,f.dialogs,f.dir);
  try{await recovered.recover();const interrupted=copy.list<any>('messages').find(m=>m.role==='assistant');expect(interrupted.status).toBe('failed');expect(interrupted.metrics).toMatchObject({interrupted:true,usage:normalized});expect(interrupted.metrics.durationMs).toBeUndefined();expect(interrupted.metrics.completedAt).toBeUndefined();}finally{await recovered.dispose();copy.close();}
  await f.service.call('chat.cancel',{requestId:sent.requestId});expect(await sent.done).toBe('chatCancelled');expect((f.assistant() as any).metrics.durationMs).toBeGreaterThanOrEqual(0);expect((f.assistant() as any).metrics.completedAt).toBeTruthy();expect(controller).toBeDefined();
 });
 it.each(['partial','missing'] as const)('sums model rounds with %s final usage while tracking field coverage separately',async finalUsage=>{
  const f=await fixture(),id=randomUUID(),stamp=new Date().toISOString(),schema={type:'object',properties:{},additionalProperties:false};
  await f.store.transaction(()=>f.store.put('mcpServers',{id,version:1,createdAt:stamp,updatedAt:stamp,name:'fixture tool',transport:'http',url:'https://mcp-fixture.invalid',command:'',args:[],enabled:true,ownerPluginId:null,configVersion:1,credentialConfigured:false,tools:[{name:'lookup',inputSchema:schema}],resources:[],prompts:[],discoveredAt:stamp}));
  await f.service.call('grants.save',{scopeType:'conversation',scopeId:f.conversation.id,mcpId:id,configVersion:1,capabilityType:'tool',capabilityName:'lookup',readOnly:true,allowedSchema:schema});vi.spyOn(f.service.mcp,'call').mockResolvedValue('{}');
  let count=0;vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{const body=JSON.parse(init.body as string);return ++count===1?new Response(event({choices:[{delta:{tool_calls:[{index:0,id:'one',function:{name:body.tools[0].function.name,arguments:'{}'}}]},finish_reason:'tool_calls'}]})+event({choices:[],usage})+'data: [DONE]\n\n'):finalUsage==='partial'?stream({prompt_tokens:10,completion_tokens:2,total_tokens:12}):new Response(stop+'data: [DONE]\n\n');}));
  const sent=await f.send({...emptyContext(),mcpRefs:[{id,configVersion:1,capabilityNames:['lookup']}]});expect(await sent.done).toBe('chatDone');expect(f.assistant().metrics).toMatchObject({rounds:2,completedRounds:2,usage:finalUsage==='partial'?{inputTokens:110,outputTokens:22,totalTokens:132,cachedInputTokens:80}:normalized,reportedRounds:{inputTokens:finalUsage==='partial'?2:1,totalTokens:finalUsage==='partial'?2:1,cachedInputTokens:1}});
 });
 it('keeps old backup messages valid and rejects impossible or unknown metric data',()=>{
  const m={id:randomUUID(),conversationId:randomUUID(),requestId:randomUUID(),role:'assistant',content:'old',status:'complete',createdAt:new Date().toISOString()};expect(backupSchemas.messages.parse(m).metrics).toBeUndefined();
  const base={startedAt:m.createdAt,rounds:1,completedRounds:1,usage:{inputTokens:0},reportedRounds:{inputTokens:1}};expect(backupSchemas.messages.parse({...m,metrics:base}).metrics).toEqual(base);
  for(const metrics of [{...base,durationMs:-1},{...base,rounds:0},{...base,completedRounds:2},{...base,reportedRounds:{inputTokens:2}},{...base,usage:{inputTokens:Number.MAX_SAFE_INTEGER+1}},{...base,secret:'not allowed'}])expect(()=>backupSchemas.messages.parse({...m,metrics})).toThrow();
 });
});
