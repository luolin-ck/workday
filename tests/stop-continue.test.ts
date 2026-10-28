import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppService} from '../src/main/service';
import {Store} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {emptyContext} from '../src/shared/types';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllGlobals();});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workday-stop-test-')),store=await Store.open(path.join(dir,'workday.sqlite'));
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()});await credentials.init();
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>null,openBackup:async()=>null,openExternal:async()=>{},openDirectory:async()=>{}},dir);
 cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 const requests:any[]=[],streams:ReadableStreamDefaultController<Uint8Array>[]=[];
 const encode=(v:unknown)=>new TextEncoder().encode('data: '+JSON.stringify(v)+'\n\n');
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>{
  requests.push(JSON.parse(String(init.body)));
  return new Response(new ReadableStream<Uint8Array>({start(controller){streams.push(controller);const abort=()=>controller.error(new DOMException('Stopped','AbortError'));if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
 }));
 const src=await service.call('sources.save',{name:'Stop fixture',baseUrl:'https://stop.invalid/v1',models:[{id:'stop-fixture',name:'Fixture',supportsTools:true}]});
 const model={sourceId:src.id,modelId:'stop-fixture'},chat=await service.call('conversations.create',{projectId:null,date:null,model});
 const waitRequests=async(n:number)=>vi.waitFor(()=>{expect(store.list<any>('messages').find(m=>m.status==='failed')?.error).toBeUndefined();expect(streams).toHaveLength(n);},{timeout:10000});
 const delta=async(n:number,text:string)=>{streams[n].enqueue(encode({choices:[{delta:{content:text},finish_reason:null}]}));await vi.waitFor(()=>expect(store.list<any>('messages').filter(m=>m.role==='assistant').at(-1).content).toContain(text),{timeout:10000});};
 const done=async(n:number,text='DONE')=>{streams[n].enqueue(encode({choices:[{delta:{content:text},finish_reason:'stop'}]}));streams[n].enqueue(encode({choices:[],usage:{prompt_tokens:10+n,completion_tokens:3,total_tokens:13+n}}));streams[n].enqueue(new TextEncoder().encode('data: [DONE]\n\n'));streams[n].close();await vi.waitFor(()=>expect(store.get<any>('conversations',chat.id).activeRequestId).toBeNull(),{timeout:10000});};
 const send=(text:string)=>service.call('chat.send',{conversationId:chat.id,text,model,context:emptyContext()});
 const stop=(requestId:string)=>service.call('chat.cancel',{requestId});
 const resume=(requestId:string)=>service.call('chat.continue' as any,{conversationId:chat.id,requestId}) as Promise<any>;
 return {dir,store,service,src,model,chat,requests,streams,waitRequests,delta,done,send,stop,resume};
}
const text=(messages:any[])=>messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
const count=(value:string,part:string)=>value.split(part).length-1;

describe('interrupted conversation continuity',()=>{
 it('settles stop before accepting a new instruction and preserves original input and partial text once',async()=>{
  const f=await fixture(),first=await f.send('ORIGINAL_PROMPT');await f.waitRequests(1);await f.delta(0,'PARTIAL_A');
  await f.stop(first.requestId);expect(f.store.get<any>('conversations',f.chat.id).activeRequestId).toBeNull();
  await f.send('NEW_INSTRUCTION');await f.waitRequests(2);const history=text(f.requests[1].messages);
  for(const part of ['ORIGINAL_PROMPT','PARTIAL_A','NEW_INSTRUCTION'])expect(count(history,part)).toBe(1);
  await f.done(1);
 });
 it('continues twice without dropping or duplicating the displayed prefix, user turn, protocol or attempt metrics',async()=>{
  const f=await fixture(),first=await f.send('ORIGINAL_PROMPT');await f.waitRequests(1);await f.delta(0,'PREFIX_A');await f.stop(first.requestId);
  const second=await f.resume(first.requestId);expect(second.continuationPrefix).toBe('PREFIX_A');await f.waitRequests(2);await f.delta(1,'PREFIX_B');await f.stop(second.requestId);
  const third=await f.resume(second.requestId);await f.waitRequests(3);await f.done(2,'TAIL_C');
  const rows=await f.service.call('conversations.history',{id:f.chat.id}),last=rows.filter(m=>m.role==='assistant').at(-1)!;
  expect(last.content).toBe('PREFIX_APREFIX_BTAIL_C');expect(rows.filter(m=>m.role==='user')).toHaveLength(1);
  expect(last.metrics?.usage?.totalTokens).toBe(15);expect(rows.find(m=>m.requestId===first.requestId&&m.role==='assistant')?.status).toBe('cancelled');
  expect(count(text(f.requests[2].messages),'PREFIX_A')).toBe(1);expect(count(text(f.requests[2].messages),'PREFIX_B')).toBe(1);
  await f.send('FOLLOWUP');await f.waitRequests(4);for(const p of ['ORIGINAL_PROMPT','PREFIX_A','PREFIX_B','TAIL_C'])expect(count(text(f.requests[3].messages),p)).toBe(1);await f.done(3);
  expect(third.requestId).not.toBe(second.requestId);
 });
 it('keeps an interrupted user message even before the first token',async()=>{
  const f=await fixture(),first=await f.send('ZERO_TOKEN_PROMPT');await f.waitRequests(1);await f.stop(first.requestId);await f.send('FOLLOWUP');await f.waitRequests(2);expect(text(f.requests[1].messages)).toContain('ZERO_TOKEN_PROMPT');await f.done(1);
 });
 it('binds continuation to the latest exact cancelled attempt and accepts only one concurrent resume',async()=>{
  const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PREFIX');await f.stop(first.requestId);
  const results=await Promise.allSettled([f.resume(first.requestId),f.resume(first.requestId)]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);const second=(results[0] as PromiseFulfilledResult<any>).value;await f.waitRequests(2);await f.stop(second.requestId);
  await expect(f.resume(first.requestId)).rejects.toThrow();await f.send('NEWER');await f.waitRequests(3);await f.done(2);await expect(f.resume(second.requestId)).rejects.toThrow();
 });
});

it('preserves attachment bytes and completed tool pairs through continue without executing them again',async()=>{
 const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PARTIAL');await f.stop(first.requestId);
 const {interruptedProtocol}=await import('../src/main/interrupted-chat'),{sentUserProtocolHash}=await import('../src/main/sent-attachments');
 const request=f.store.get<any>('requests',first.requestId),png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 request.protocol[1]={role:'user',content:[{type:'text',text:'ORIGINAL\nATTACHMENT_TEXT'},{type:'image_url',image_url:{url:png}}]};request.userProtocolHash=sentUserProtocolHash(request.protocol[1]);
 request.protocol.push({role:'assistant',content:'TOOL_NARRATION',tool_calls:[{id:'done-tool',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'done-tool',content:'CONFIRMED_RESULT'});request.toolCount=1;
 request.interruptedProtocol=interruptedProtocol(request.protocol,'PARTIAL').protocol;
 await f.store.transaction(()=>f.store.put('requests',request));const spy=vi.spyOn(f.service.mcp,'call');
 const second=await f.resume(first.requestId);await f.waitRequests(2);const payload=text(f.requests[1].messages);
 for(const part of ['ATTACHMENT_TEXT',png,'TOOL_NARRATION','CONFIRMED_RESULT','PARTIAL'])expect(count(payload,part)).toBe(1);
 expect(f.requests[1].messages.filter((m:any)=>m.role==='tool')).toEqual([{role:'tool',tool_call_id:'done-tool',content:'CONFIRMED_RESULT'}]);expect(spy).not.toHaveBeenCalled();await f.done(1);
 expect(f.store.get<any>('requests',second.requestId).toolCount).toBe(1);spy.mockRestore();
});

it('rejects uncertain continuation but carries only inert confirmed references into a new request',async()=>{
 const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PARTIAL');await f.stop(first.requestId);
 const {interruptedProtocol}=await import('../src/main/interrupted-chat');const request=f.store.get<any>('requests',first.requestId);
 request.protocol.push({role:'assistant',content:'NARRATION',tool_calls:[{id:'done',type:'function',function:{name:'lookup',arguments:'{}'}},{id:'unknown',type:'function',function:{name:'write',arguments:'{}'}}]},{role:'tool',tool_call_id:'done',content:'CONFIRMED_ONLY'});request.pendingTool='unknown';
 const safe=interruptedProtocol(request.protocol,'PARTIAL',request.pendingTool);request.interruptedProtocol=safe.protocol;request.interruptedUncertain=safe.uncertain;
 await f.store.transaction(()=>f.store.put('requests',request));await expect(f.resume(first.requestId)).rejects.toThrow('不能继续');
 await f.send('NEW_INSTRUCTION');await f.waitRequests(2);expect(f.requests[1].messages.some((m:any)=>m.tool_calls||m.role==='tool')).toBe(false);
 expect(text(f.requests[1].messages)).toContain('CONFIRMED_ONLY');expect(text(f.requests[1].messages)).toContain('completion is unknown');await f.done(1);
});

it('rejects stale source, archive, management, images and ambiguous original input before adding a continuation',async()=>{
 const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PARTIAL');await f.stop(first.requestId);
 const original=f.store.get<any>('requests',first.requestId),chat=f.store.get<any>('conversations',f.chat.id);
 for(const patch of [{component:{fixture:true}},{imageJobId:randomUUID()},{userProtocolHash:'wrong'}]){
  await f.store.transaction(()=>f.store.put('requests',{...original,...patch}));await expect(f.resume(first.requestId)).rejects.toThrow();expect(f.store.list('requests')).toHaveLength(1);
 }
 await f.store.transaction(()=>{f.store.put('requests',original);f.store.put('conversations',{...chat,archived:true});});await expect(f.resume(first.requestId)).rejects.toThrow('归档');
 await f.store.transaction(()=>f.store.put('conversations',chat));await f.service.call('sources.save',{id:f.src.id,expectedVersion:f.src.version,name:'Changed',baseUrl:f.src.baseUrl,models:f.src.models});await expect(f.resume(first.requestId)).rejects.toThrow('源配置');expect(f.store.list('requests')).toHaveLength(1);
});

it('does not let an older interrupted retry truncate later completed turns and refuses lost interrupted history explicitly',async()=>{
 const f=await fixture(),first=await f.send('FIRST_USER');await f.waitRequests(1);await f.delta(0,'FIRST_PARTIAL');await f.stop(first.requestId);
 await f.send('SECOND_USER');await f.waitRequests(2);await f.done(1,'SECOND_FINAL');const old=f.store.get<any>('requests',first.requestId);
 await f.store.transaction(()=>f.store.put('requests',{...old,id:randomUUID()}));await f.send('THIRD_USER');await f.waitRequests(3);expect(text(f.requests[2].messages)).toContain('SECOND_FINAL');await f.stop(f.store.get<any>('conversations',f.chat.id).activeRequestId);
 const latest=f.store.list<any>('requests').at(-1);await f.store.transaction(()=>f.store.put('requests',{...latest,interruptedProtocol:undefined,interruptedError:'中断上下文超过限制'}));
 await expect(f.send('FOLLOWUP')).rejects.toThrow('中断上下文超过限制');expect(f.requests).toHaveLength(3);
});

it('backs up safe interrupted context as reference history without restoring execution permission',async()=>{
 const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PARTIAL');await f.stop(first.requestId);
 const backup=await f.service.backup(),message=backup.rows.messages.find((m:any)=>m.role==='assistant');expect(text(message.snapshot.interruptedProtocol)).toContain('PARTIAL');expect(backup.rows.requests).toEqual([]);expect(message.continuable).toBeUndefined();
});

it('bounds accumulated continuation text without making saved message snapshots unreadable',async()=>{
 const f=await fixture(),first=await f.send('ORIGINAL');await f.waitRequests(1);await f.delta(0,'PARTIAL');await f.stop(first.requestId);
 const request=f.store.get<any>('requests',first.requestId),message=f.store.get<any>('messages',request.assistantMessageId);
 await f.store.transaction(()=>f.store.put('messages',{...message,content:'A'.repeat(200001)}));
 await expect(f.resume(first.requestId)).rejects.toThrow('不能继续');expect(f.store.list('requests')).toHaveLength(1);
 await f.store.transaction(()=>f.store.put('messages',{...message,content:'A'.repeat(199999)}));
 const continued=await f.resume(first.requestId);await f.waitRequests(2);f.streams[1].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'OVER'},finish_reason:null}]})+'\n\n'));
 await vi.waitFor(()=>expect(f.store.get<any>('requests',continued.requestId).status).toBe('failed'),{timeout:5000});
 const rows=await f.service.call('conversations.history',{id:f.chat.id}),last=rows.filter(m=>m.role==='assistant').at(-1)!;expect(last.content).toBe('A'.repeat(199999));expect(last.error).toBe('回复过长');
});
