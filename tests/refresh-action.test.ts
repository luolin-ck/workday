import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Store} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {AppService} from '../src/main/service';
import {emptyContext} from '../src/shared/types';
import {visibleChatMessages} from '../src/renderer/chat-attempts';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllGlobals();vi.restoreAllMocks();});
const reply=(content:string,total=10)=>new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:total-2,total_tokens:total}})+'\n\ndata: [DONE]\n\n');
async function fixture(){
 const dir=await fs.mkdtemp('/private/tmp/workday-refresh-unit-'),store=await Store.open(path.join(dir,'workday.sqlite'));
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()});await credentials.init();
 let backupPath:string|null=null;
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>null,openBackup:async()=>backupPath,openExternal:async()=>{},openDirectory:async()=>{}},dir);
 cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 const bodies:any[]=[];let response=(_signal:AbortSignal)=>Promise.resolve(reply('FIRST_FINAL'));
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{bodies.push(JSON.parse(init.body));return response(init.signal);}));
 const source=await service.call('sources.save',{name:'Synthetic refresh fixture',baseUrl:'https://refresh.invalid/v1',models:[{id:'mock',name:'mock',supportsTools:true}]}),model={sourceId:source.id,modelId:'mock'};
 const chat=await service.call('conversations.create',{projectId:null,date:null,model});
 const done=async(result:{requestId:string},status='complete')=>vi.waitFor(()=>expect(store.get<any>('requests',result.requestId).status).toBe(status));
 const send=async(text='ORIGINAL_USER')=>{const result=await service.call('chat.send',{conversationId:chat.id,text,model,context:emptyContext()});await done(result);return result;};
 return {dir,store,service,chat,source,model,bodies,done,send,response:(fn:typeof response)=>response=fn,backup:(file:string)=>backupPath=file,history:()=>service.call('conversations.history',{id:chat.id}),retry:(userMessageId:string)=>service.call('chat.retry',{conversationId:chat.id,userMessageId})};
}

it('regenerates a completed turn with frozen input, one user, unchanged original and independent metrics; persists replacement through backup',async()=>{
 const f=await fixture(),sent=await f.send(),original=structuredClone(f.store.get<any>('requests',sent.requestId)),oldMessage=(await f.history()).at(-1)!;
 f.response(async()=>reply('SECOND_FINAL',23));
 const retry=await f.retry(sent.userMessageId);await f.done(retry);
 expect(f.bodies[1].messages).toEqual(original.protocol.slice(0,-1));expect(JSON.stringify(f.bodies[1])).not.toContain('FIRST_FINAL');
 expect(f.store.get('requests',sent.requestId)).toEqual(original);expect(f.store.get<any>('requests',retry.requestId).replacesMessageId).toBe(oldMessage.id);
 const history=await f.history(),current=history.at(-1)!;expect(history.filter(m=>m.role==='user')).toHaveLength(1);expect(history.filter(m=>m.role==='assistant')).toHaveLength(2);
 expect(current.snapshot).toMatchObject({replacesMessageId:oldMessage.id,userMessageId:sent.userMessageId});expect(current.metrics?.usage?.totalTokens).toBe(23);expect(history.find(m=>m.id===oldMessage.id)?.metrics).toEqual(oldMessage.metrics);
 expect(visibleChatMessages(history).map(m=>m.id)).toEqual([sent.userMessageId,current.id]);
 const backup=await f.service.backup(),file=path.join(f.dir,'backup.json');await fs.writeFile(file,JSON.stringify(backup));f.backup(file);
 const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));
 try{expect(visibleChatMessages(copy.list<any>('messages')).map(m=>m.id)).toEqual([sent.userMessageId,current.id]);}finally{copy.close();}
});

it('reuses attachment and completed tool evidence without replaying calls or stale file proposals',async()=>{
 const f=await fixture(),sent=await f.send(),request=f.store.get<any>('requests',sent.requestId),assistant=f.store.get<any>('messages',request.assistantMessageId);
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 request.protocol[1]={role:'user',content:[{type:'text',text:'ORIGINAL_USER\nATTACHMENT_TEXT'},{type:'image_url',image_url:{url:png}}]};
 request.protocol.splice(2,0,{role:'assistant',content:null,tool_calls:[{id:'old-call',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'old-call',content:'REUSABLE_TOOL_RESULT'});
 request.toolCount=1;request.proposedFile={path:'must-not-duplicate.txt'};assistant.snapshot={...assistant.snapshot,protocol:request.protocol};
 await f.store.transaction(()=>{f.store.put('requests',request);f.store.put('messages',assistant);});const frozen=structuredClone(request);
 const tool=vi.spyOn(f.service.mcp,'call');f.response(async()=>reply('REGENERATED'));const retry=await f.retry(sent.userMessageId);await f.done(retry);
 expect(f.bodies.at(-1).messages).toEqual(frozen.protocol.slice(0,-1));expect(tool).not.toHaveBeenCalled();expect(f.store.list('drafts')).toHaveLength(0);
 expect(f.store.get<any>('requests',retry.requestId)).toMatchObject({toolCount:1});expect(f.store.get<any>('requests',retry.requestId).proposedFile).toBeUndefined();expect(f.store.get('requests',sent.requestId)).toEqual(frozen);
});

it.each(['failed','cancelled'] as const)('keeps the completed answer on %s regeneration, then replaces only after retry succeeds',async status=>{
 const f=await fixture(),sent=await f.send(),first=(await f.history()).at(-1)!;
 if(status==='failed')f.response(async()=>new Response('synthetic failure',{status:503}));
 else f.response(signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})));
 const retry=await f.retry(sent.userMessageId);
 if(status==='cancelled'){await vi.waitFor(()=>expect(f.bodies).toHaveLength(2));await f.service.call('chat.cancel',{requestId:retry.requestId});}
 await f.done(retry,status);const failed=(await f.history()).at(-1)!;expect(visibleChatMessages(await f.history()).map(m=>m.id)).toContain(first.id);
 expect(failed.snapshot).toMatchObject({replacesMessageId:first.id});f.response(async()=>reply('RECOVERED',7));
 const next=await f.retry(sent.userMessageId);await f.done(next);const history=await f.history();expect(visibleChatMessages(history).map(m=>m.id)).toEqual([sent.userMessageId,history.at(-1)!.id]);
 expect(f.store.get<any>('requests',next.requestId).error).toBeUndefined();expect(f.store.list('requests')).toHaveLength(3);
});

it('rejects preflight corruption, stale source and older turns without losing the answer or latest context',async()=>{
 const f=await fixture(),sent=await f.send(),request=f.store.get<any>('requests',sent.requestId),before=await f.history();
 await f.store.transaction(()=>f.store.put('requests',{...request,protocol:[...request.protocol,{role:'user',content:'invalid final boundary'}]}));
 await expect(f.retry(sent.userMessageId)).rejects.toThrow('最终回复');expect(await f.history()).toEqual(before);expect(f.bodies).toHaveLength(1);
 await f.store.transaction(()=>f.store.put('requests',request));f.response(async()=>reply('LATEST_SECOND'));await f.send('SECOND_USER');
 await expect(f.retry(sent.userMessageId)).rejects.toThrow('最新一轮');expect(f.store.list('requests')).toHaveLength(2);
 await f.send('THIRD_USER');expect(JSON.stringify(f.bodies[2])).toContain('SECOND_USER');expect(JSON.stringify(f.bodies[2])).toContain('LATEST_SECOND');
 const latest=f.store.list<any>('requests').at(-1)!;await f.service.call('sources.save',{id:f.source.id,expectedVersion:f.source.version,name:'Changed',baseUrl:f.source.baseUrl,models:f.source.models});
 const history=await f.history();await expect(f.retry(latest.userMessageId)).rejects.toThrow('源配置');expect(await f.history()).toEqual(history);
});

it('rejects older failed regeneration chains and rechecks latest user inside the commit',async()=>{
 const f=await fixture(),sent=await f.send();f.response(async()=>new Response('',{status:503}));const retry=await f.retry(sent.userMessageId);await f.done(retry,'failed');
 f.response(async()=>reply('NEXT'));await f.send('LATER_USER');await expect(f.retry(sent.userMessageId)).rejects.toThrow('最新一轮');
 const latest=f.store.list<any>('requests').at(-1)!;const secretChange=(f.service as any).secretChange.bind(f.service);
 vi.spyOn(f.service as any,'secretChange').mockImplementationOnce(async(work:any)=>{await f.store.transaction(()=>f.store.put('messages',{id:randomUUID(),requestId:randomUUID(),conversationId:f.chat.id,role:'user',status:'complete',content:'racing user',createdAt:new Date().toISOString()}));return secretChange(work);});
 await expect(f.retry(latest.userMessageId)).rejects.toThrow('最新一轮');expect(f.bodies).toHaveLength(3);
});

it('allows just one concurrent regeneration and keeps running, archived and management requests guarded',async()=>{
 const f=await fixture(),sent=await f.send();f.response(signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})));
 const results=await Promise.allSettled([f.retry(sent.userMessageId),f.retry(sent.userMessageId)]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
 const retry=(results[0] as PromiseFulfilledResult<any>).value;await vi.waitFor(()=>expect(f.bodies).toHaveLength(2));await expect(f.retry(sent.userMessageId)).rejects.toThrow();
 await f.service.call('chat.cancel',{requestId:retry.requestId});await f.done(retry,'cancelled');
 const c=f.store.get<any>('conversations',f.chat.id);await f.service.call('conversations.archive',{id:c.id,expectedVersion:c.version,archived:true});await expect(f.retry(sent.userMessageId)).rejects.toThrow('归档');
 const r=f.store.get<any>('requests',retry.requestId);await f.store.transaction(()=>f.store.put('requests',{...r,component:{fixture:true}}));await expect(f.retry(sent.userMessageId)).rejects.toThrow('管理请求');
 expect((await f.history()).filter(m=>m.role==='user')).toHaveLength(1);
});

it('refreshes a completed image from its verified source without generation and keeps the unknown guard',async()=>{
 const f=await fixture();
 const generation=vi.spyOn(f.service.images as any,'generate').mockRejectedValue(new Error('must not generate'));
 const run=vi.spyOn(f.service.images,'run').mockImplementationOnce(async id=>{
  const job=await f.service.images.load(id),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const media={id:randomUUID(),jobId:id,name:'source.png' as const,mime:'image/png' as const,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:1,height:1,frameCount:1 as const,relativePath:`image-jobs/${id}/source.png`};
  await fs.writeFile(path.join(f.dir,media.relativePath),bytes);const complete={...job,stage:'complete' as const,generation:'complete' as const,source:media,media:[media]};
  await fs.writeFile(path.join(f.dir,'image-jobs',id,'manifest.json'),JSON.stringify(complete));return complete;
 });
 const sent=await f.send('生成图片'),original=f.store.get<any>('requests',sent.requestId),old=(await f.history()).at(-1)!;run.mockRestore();
 const retry=await f.retry(sent.userMessageId);await f.done(retry);const history=await f.history();expect(history.at(-1)?.media).toEqual(old.media);
 expect(visibleChatMessages(history).map(m=>m.id)).toEqual([sent.userMessageId,history.at(-1)!.id]);expect(generation).not.toHaveBeenCalled();expect(f.bodies).toHaveLength(0);
 expect(f.store.get<any>('requests',retry.requestId).protocol).toHaveLength(original.protocol.length);
 const file=path.join(f.dir,'image-jobs',original.imageJobId,'manifest.json'),manifest=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...manifest,generation:'unknown',stage:'unknown'}));
 await expect(f.retry(sent.userMessageId)).rejects.toThrow('计费');expect(await f.history()).toEqual(history);expect(f.store.list('requests')).toHaveLength(2);
});
