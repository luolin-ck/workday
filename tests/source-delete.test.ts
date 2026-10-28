import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,atomicWrite} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {AppService} from '../src/main/service';
import {emptyContext,type Source} from '../src/shared/types';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const f of cleanup.splice(0).reverse())await f();});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wd-source-delete-'));let fail=false,selected:string|null=null;
 const store=await Store.open(path.join(dir,'workday.sqlite'),async(file,data)=>{if(fail)throw Error('synthetic persist failure');await atomicWrite(file,data);});
 const crypto={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from('sealed:'+s),decryptString:(b:Buffer)=>b.toString().slice(7)};
 const credentials=new Credentials(path.join(dir,'credentials.json'),crypto);await credentials.init();
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>selected,openBackup:async()=>selected,openExternal:async()=>{},openDirectory:async()=>{}},dir);
 cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,store,credentials,service,crypto,fail:(v:boolean)=>fail=v,select:(v:string)=>selected=v};
}
async function source(f:Awaited<ReturnType<typeof fixture>>,name='Synthetic',secret='synthetic-key'){return f.service.call('sources.save',{name,baseUrl:'https://source-delete.invalid/v1',models:[{id:'model',name:'Model',supportsTools:false}],secret});}
const remove=(f:Awaited<ReturnType<typeof fixture>>,s:Source)=>f.service.call('sources.delete',{id:s.id,expectedVersion:s.version});
const model=(s:Source)=>({sourceId:s.id,modelId:'model'});
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
describe('model source deletion',()=>{
 it('deletes only the chosen source and credential, clears its default, pauses all dependencies and preserves history/backup',async()=>{
  const f=await fixture(),a=await source(f),b=await source(f,'Other','other-key');
  await f.service.call('settings.defaultModel',{model:model(a)});
  const c=await f.service.call('conversations.create',{projectId:null,date:null,model:model(a)});
  const message={id:randomUUID(),conversationId:c.id,requestId:randomUUID(),role:'assistant',content:'Synthetic historical response',status:'complete',createdAt:new Date().toISOString()};
  const makeSchedule=(s:Source,name:string)=>f.service.call('schedules.save',{name,prompt:'Synthetic',projectId:null,model:model(s),context:emptyContext(),spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});
  const paused=await makeSchedule(a,'Paused'),active=await makeSchedule(a,'Active'),other=await makeSchedule(b,'Other');
  await f.service.call('schedules.toggle',{id:active.id,expectedVersion:active.version,enabled:true});
  await f.store.transaction(()=>f.store.put('messages',message));
  expect(await remove(f,a)).toBe(true);
  const state=await f.service.call('state.get',{});expect(state.sources).toEqual([b]);expect(state.defaultModel).toBeNull();
  expect(f.credentials.configured('source:'+a.id)).toBe(false);expect(f.credentials.get('source:'+b.id)).toBe('other-key');
  expect(state.conversations.find(x=>x.id===c.id)).toEqual(c);expect(await f.service.call('conversations.history',{id:c.id})).toEqual([message]);
  for(const id of [paused.id,active.id])expect(state.schedules.find(s=>s.id===id)).toMatchObject({enabled:false,status:'paused',nextRunAt:null,nextSlot:null,pauseReason:'模型源已删除，请重新选择模型'});
  expect(state.schedules.find(s=>s.id===other.id)).toEqual(other);
  const reopened=await Store.open(f.store.file);expect(reopened.get('sources',a.id)).toBeUndefined();reopened.close();
  const file=path.join(f.dir,'backup.json');await fs.writeFile(file,JSON.stringify(await f.service.backup()));f.select(file);expect(await f.service.call('data.validate',{})).not.toBeNull();
 });
 it('keeps an unrelated default and accepts deleting a source without credentials',async()=>{
  const f=await fixture(),a=await source(f,'No secret',''),b=await source(f,'Other');await f.service.call('settings.defaultModel',{model:model(b)});
  await remove(f,a);expect((await f.service.call('state.get',{})).defaultModel).toEqual(model(b));
 });
 it('rejects stale, missing and invalid inputs without any credential mutation',async()=>{
  const f=await fixture(),a=await source(f),before=await fs.readFile(path.join(f.dir,'credentials.json'));
  const changed=await f.service.call('sources.toggle',{id:a.id,expectedVersion:a.version,enabled:false});
  await expect(remove(f,a)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(remove(f,{...changed,id:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(f.service.call('sources.delete',{id:a.id} as any)).rejects.toThrow('参数');
  expect(await fs.readFile(path.join(f.dir,'credentials.json'))).toEqual(before);
 });
 it.each(['conversation','schedule'])('rejects a running %s request before deletion',async scopeType=>{
  const f=await fixture(),a=await source(f);await f.store.transaction(()=>f.store.put('requests',{id:randomUUID(),status:'running',model:model(a),scopeType}));
  await expect(remove(f,a)).rejects.toThrow('正在生成');expect(f.store.get('sources',a.id)).toEqual(a);expect(f.credentials.get('source:'+a.id)).toBe('synthetic-key');
 });
 it('keeps the database unchanged when credential persistence fails',async()=>{
  const f=await fixture(),a=await source(f),before=f.store.exportRows(),original=fs.rename;
  vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to)===path.join(f.dir,'credentials.json'))throw Error('synthetic credential write failure');return original(from,to);});
  await expect(remove(f,a)).rejects.toThrow();expect(f.store.exportRows()).toEqual(before);expect(f.credentials.get('source:'+a.id)).toBe('synthetic-key');
 });
 it('restores exact ciphertext after database failure without decrypting, then supports deletion with unavailable crypto',async()=>{
  const f=await fixture(),a=await source(f),before=await fs.readFile(path.join(f.dir,'credentials.json'));
  vi.spyOn(f.crypto,'isEncryptionAvailable').mockReturnValue(false);const decrypt=vi.spyOn(f.crypto,'decryptString').mockImplementation(()=>{throw Error('must not decrypt');});
  f.fail(true);await expect(remove(f,a)).rejects.toThrow('synthetic persist failure');f.fail(false);
  expect(f.store.get('sources',a.id)).toEqual(a);expect(await fs.readFile(path.join(f.dir,'credentials.json'))).toEqual(before);expect(f.credentials.configured('source:'+a.id)).toBe(true);
  await remove(f,a);expect(decrypt).not.toHaveBeenCalled();expect(f.credentials.configured('source:'+a.id)).toBe(false);
 });
 it('serializes duplicate deletes and source edit against deletion',async()=>{
  const f=await fixture(),a=await source(f);const results=await Promise.allSettled([remove(f,a),remove(f,a),f.service.call('sources.save',{id:a.id,expectedVersion:a.version,name:a.name,baseUrl:a.baseUrl,models:a.models,secret:'replacement'})]);
  expect(results.map(x=>x.status)).toEqual(['fulfilled','rejected','rejected']);expect(f.credentials.configured('source:'+a.id)).toBe(false);expect(f.store.list('sources')).toEqual([]);
 });
 it.each(['sources.models','sources.test'] as const)('does not resurrect deleted source from late %s result',async op=>{
  const f=await fixture(),a=await source(f),started=deferred<void>(),reply=deferred<Response>();
  vi.stubGlobal('fetch',async()=>{started.resolve();return reply.promise;});
  const pending=f.service.call(op,op==='sources.models'?{id:a.id}:{id:a.id,modelId:'model'}).catch(e=>e);await started.promise;await remove(f,a);
  reply.resolve(new Response(JSON.stringify(op==='sources.models'?{data:[{id:'late'}]}:{choices:[{message:{content:'OK'}}]})));
  expect(await pending).toMatchObject({code:'NOT_FOUND'});expect(f.store.list('sources')).toEqual([]);
 });
 it('a send queued behind deletion never commits or sends using the deleted source',async()=>{
  const f=await fixture(),a=await source(f),c=await f.service.call('conversations.create',{projectId:null,date:null,model:model(a)}),entered=deferred<void>(),release=deferred<void>();
  const original=fs.rename;vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(String(to)===path.join(f.dir,'credentials.json')){entered.resolve();await release.promise;}return original(from,to);});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const deleting=remove(f,a);await entered.promise;const sending=f.service.call('chat.send',{conversationId:c.id,text:'Synthetic',model:model(a),context:emptyContext()}).catch(e=>e);release.resolve();await deleting;
  expect(await sending).toMatchObject({code:'NOT_FOUND'});expect(fetch).not.toHaveBeenCalled();expect(f.store.list('messages')).toEqual([]);expect(f.store.get<any>('conversations',c.id).activeRequestId).toBeNull();
 });
});
