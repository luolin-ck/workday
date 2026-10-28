import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Settings} from 'luxon';
import {AppService} from '../src/main/service';
import {Credentials} from '../src/main/credentials';
import {Store} from '../src/main/store';
import type {Draft,TaskAction} from '../src/shared/types';
import {emptyContext} from '../src/shared/types';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
async function fixture(){
 const root=path.resolve('test-data');await fs.mkdir(root,{recursive:true});
 const dir=await fs.mkdtemp(path.join(root,'priority-')),store=await Store.open(path.join(dir,'workday.sqlite'));
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('test:'+s),decryptString:b=>b.toString().slice(5)});await credentials.init();
 let backupFile:string|null=null;
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>backupFile,openBackup:async()=>backupFile,openExternal:async()=>{},openDirectory:async()=>{}},dir);
 cleanups.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 return {store,service,dir,setBackup:(file:string)=>{backupFile=file;}};
}
const fields={title:'合成优先级事项',notes:'保留备注',date:'2028-05-20',dueDate:'2028-05-21',projectId:null,completed:false};
const identity=()=>({id:randomUUID(),version:3,createdAt:'2025-01-01T00:00:00.000Z',updatedAt:'2025-02-01T00:00:00.000Z'});

describe('task priority persistence',()=>{
 it('defaults new tasks to P2 and preserves an explicitly selected priority through ordinary edits and delete/restore',async()=>{
  const f=await fixture();let task=await f.service.call('tasks.save',fields);expect(task.priority).toBe('P2');
  for(const priority of ['P0','P1','P2'] as const){
   const previous=task;
   task=await f.service.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,priority});
   expect(task).toMatchObject({...fields,priority,version:previous.version+1});
   task=await f.service.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,title:'内容已修改',completed:true});
   expect(task).toMatchObject({priority,title:'内容已修改',completed:true,dueDate:fields.dueDate});
   task=await f.service.call('tasks.delete',{id:task.id,expectedVersion:task.version});expect(task.priority).toBe(priority);
   task=await f.service.call('tasks.restore',{id:task.id,expectedVersion:task.version});expect(task.priority).toBe(priority);
   await expect(f.service.call('tasks.save',{...fields,id:task.id,expectedVersion:previous.version,priority:'P0'})).rejects.toMatchObject({code:'CONFLICT'});
   expect(f.store.get('tasks',task.id)).toEqual(task);
  }
  const reopened=await Store.open(f.store.file);try{expect(reopened.get('tasks',task.id)).toEqual(task);}finally{reopened.close();}
 });
 it('rejects invalid priority values without mutating the saved task',async()=>{
  const f=await fixture(),task=await f.service.call('tasks.save',fields);
  for(const priority of ['P3','p0','',null,0,true,{}])await expect(f.service.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,priority})).rejects.toMatchObject({code:'INVALID'});
  expect(f.store.get('tasks',task.id)).toEqual(task);
 });
 it('migrates missing legacy priorities to P2 without changing existing priorities, versions, timestamps or deleted records',async()=>{
  const f=await fixture();
  const legacy={...identity(),...fields,completed:true,deletedAt:null};
  const deleted={...legacy,id:randomUUID(),deletedAt:'2025-02-02T00:00:00.000Z'};
  const explicit=['P0','P1','P2'].map(priority=>({...legacy,id:randomUUID(),priority}));
  await f.store.transaction(()=>{for(const task of [legacy,deleted,...explicit])f.store.put('tasks',task);});
  await f.service.recover();await f.service.recover();
  const expected=[{...legacy,priority:'P2',completedDate:legacy.date},{...deleted,priority:'P2',completedDate:deleted.date},...explicit.map(task=>({...task,completedDate:task.date}))];
  expect((await f.service.call('state.get',{})).tasks).toEqual(expected);
  const reopened=await Store.open(f.store.file);try{expect(reopened.list('tasks')).toEqual(expected);}finally{reopened.close();}
 });
 it('retains P0 when an unfinished task rolls into the new local date',async()=>{
  const zone=Settings.defaultZone;Settings.defaultZone='Asia/Shanghai';vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2028-05-22T00:00:00+08:00'));
  try{
   const f=await fixture(),task={...identity(),...fields,priority:'P0',deletedAt:null};
   await f.store.transaction(()=>f.store.put('tasks',task));await f.service.tick();
   expect(f.store.get('tasks',task.id)).toMatchObject({...fields,priority:'P0',date:'2028-05-22',dueDate:fields.dueDate,version:task.version+1});
  }finally{Settings.defaultZone=zone;}
 });
 it('defaults AI-created tasks to P2 and keeps the selected priority through draft edits',async()=>{
  const f=await fixture(),conversation=await f.service.call('conversations.create',{projectId:null,date:fields.date,model:null});
  async function apply(actions:TaskAction[],taskIds:string[]=[]){
   const draft:Draft={...identity(),conversationId:conversation.id,messageId:randomUUID(),projectId:null,taskIds,actions,status:'pending',appliedTaskIds:[]};
   await f.store.transaction(()=>f.store.put('drafts',draft));return f.service.call('drafts.apply',{id:draft.id,expectedVersion:draft.version});
  }
  const created=await apply([{type:'create',title:fields.title,notes:fields.notes,date:fields.date,projectId:null}]);
  if((created.kind==='file'||created.kind==='component'))throw Error('Expected task draft');let task=(await f.service.call('state.get',{})).tasks.find(t=>t.id===created.appliedTaskIds[0])!;expect(task.priority).toBe('P2');
  task=await f.service.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,priority:'P0'});
  for(const change of [{type:'update',title:'草案修改'},{type:'complete',completed:true},{type:'reschedule',date:'2028-05-25'}] as const){
   await apply([{...change,taskId:task.id,expectedVersion:task.version}],[task.id]);task=(await f.service.call('state.get',{})).tasks[0];expect(task.priority).toBe('P0');
  }
 });
 it('includes importance in automatic calendar context without adding priority-changing AI actions',async()=>{
  const f=await fixture(),task=await f.service.call('tasks.save',{...fields,priority:'P0'});
  const source=await f.service.call('sources.save',{name:'合成模型源',baseUrl:'https://model.test/v1',models:[{id:'synthetic',name:'合成模型',supportsTools:false}]});
  const model={sourceId:source.id,modelId:'synthetic'},conversation=await f.service.call('conversations.create',{projectId:null,date:fields.date,model});
  const request=vi.fn(async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'合成回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));
  vi.stubGlobal('fetch',request);
  await f.service.call('chat.send',{conversationId:conversation.id,text:'合成问题',model,context:{...emptyContext(),date:fields.date,calendarTasks:true}});
  await vi.waitFor(()=>expect(f.store.list<any>('requests')[0]?.status).toBe('complete'));
  const body=JSON.parse((request.mock.calls[0] as unknown as [unknown,RequestInit])[1].body as string);
  const system=body.messages.find((message:any)=>message.role==='system').content as string;
  const reference=system.split('change proposals):\n')[1].split('\n\n')[0];
  expect(JSON.parse(reference)).toEqual([{id:task.id,title:task.title,notes:task.notes,date:task.date,dueDate:task.dueDate,priority:'P0',completed:task.completed,completedDate:task.completedDate,projectId:null,projectName:null}]);
  expect(system).toContain('update fields: type,taskId,expectedVersion,title/notes.');
  expect(system).not.toContain('update fields: type,taskId,expectedVersion,priority');
 });
 it('restores new and legacy backups, validates priority values and retains the checksum boundary',async()=>{
  const f=await fixture(),task=await f.service.call('tasks.save',{...fields,priority:'P0'}),original=await f.service.backup();
  const file=path.join(f.dir,'priority-backup.json');f.setBackup(file);
  const rehash=(backup:any)=>{backup.sha256=createHash('sha256').update(JSON.stringify({format:backup.format,version:backup.version,rows:backup.rows,packages:backup.packages,...(backup.version===2?{skillFiles:backup.skillFiles}:{})})).digest('hex');};
  for(const priority of [undefined,'P0','P1','P2']){
   const backup=structuredClone(original);if(priority===undefined)delete backup.rows.tasks[0].priority;else backup.rows.tasks[0].priority=priority;rehash(backup);
   await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));
   try{expect(copy.get('tasks',task.id)).toEqual({...task,priority:priority??'P2'});}finally{copy.close();}
  }
  const tampered=structuredClone(original);tampered.rows.tasks[0].priority='P1';await fs.writeFile(file,JSON.stringify(tampered));await expect(f.service.call('data.validate',{})).rejects.toThrow('校验和');
  for(const priority of ['P3','p0','',null,0]){
   const backup=structuredClone(original);backup.rows.tasks[0].priority=priority;rehash(backup);await fs.writeFile(file,JSON.stringify(backup));
   await expect(f.service.call('data.validate',{})).rejects.toMatchObject({code:'INVALID'});
  }
  expect(f.store.get('tasks',task.id)).toEqual(task);
 });
});
