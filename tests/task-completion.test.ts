import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Settings} from 'luxon';
import {AppService} from '../src/main/service';
import {Credentials} from '../src/main/credentials';
import {Store,atomicWrite} from '../src/main/store';
import {emptyContext,type Draft,type Task,type TaskAction} from '../src/shared/types';
import * as dates from '../src/shared/dates';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
function clock(time='2028-05-20T00:30:00+08:00',zone='Asia/Shanghai'){
 const previous=Settings.defaultZone;Settings.defaultZone=zone;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(time));cleanups.push(async()=>{Settings.defaultZone=previous;});
}
async function fixture(persist=atomicWrite){
 const root=path.resolve('test-data');await fs.mkdir(root,{recursive:true});
 const dir=await fs.mkdtemp(path.join(root,'completion-')),store=await Store.open(path.join(dir,'workday.sqlite'),persist);
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('test:'+s),decryptString:b=>b.toString().slice(5)});await credentials.init();
 let backupFile:string|null=null;
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>backupFile,openBackup:async()=>backupFile,openExternal:async()=>{},openDirectory:async()=>{}},dir);
 cleanups.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 return {store,service,dir,setBackup:(file:string)=>{backupFile=file;}};
}
const fields={title:'合成完成日期事项',notes:'保留备注',date:'2028-05-22',dueDate:'2028-05-23',projectId:null,completed:false};
const identity=()=>({id:randomUUID(),version:3,createdAt:'2025-01-01T00:00:00.000Z',updatedAt:'2025-02-01T00:00:00.000Z'});
const edit=(task:Task,changes:Record<string,unknown>={})=>({...fields,id:task.id,expectedVersion:task.version,completed:task.completed,...changes});

describe('task completion dates',()=>{
 it.each([
  ['Asia/Shanghai','2028-05-19T16:30:00Z','2028-05-20'],
  ['America/Los_Angeles','2027-03-14T09:30:00Z','2027-03-14'],
  ['America/Los_Angeles','2026-11-01T08:30:00Z','2026-11-01']
 ])('defaults completion to the local civil date in %s at %s',async(zone,instant,today)=>{
  clock(instant,zone);const f=await fixture();let task=await f.service.call('tasks.save',fields);expect(task.completedDate).toBeNull();
  task=await f.service.call('tasks.save',edit(task,{completed:true}));expect(task).toMatchObject({date:fields.date,completedDate:today,completed:true});
 });
 it('edits the completion day independently, preserves it in ordinary edits and clears it on reopening',async()=>{
  clock();const f=await fixture();let task=await f.service.call('tasks.save',{...fields,completed:true,completedDate:'2028-05-18'});
  expect(task).toMatchObject({date:fields.date,completedDate:'2028-05-18'});
  task=await f.service.call('tasks.save',edit(task,{title:'合成修改',priority:'P1',date:'2028-06-01'}));expect(task).toMatchObject({completedDate:'2028-05-18',date:'2028-06-01',priority:'P1'});
  task=await f.service.call('tasks.save',edit(task,{completedDate:'2028-05-19'}));expect(task.completedDate).toBe('2028-05-19');
  task=await f.service.call('tasks.delete',{id:task.id,expectedVersion:task.version});task=await f.service.call('tasks.restore',{id:task.id,expectedVersion:task.version});expect(task.completedDate).toBe('2028-05-19');
  task=await f.service.call('tasks.save',edit(task,{completed:false,completedDate:'2028-05-19'}));expect(task.completedDate).toBeNull();
  vi.setSystemTime(new Date('2028-05-24T00:30:00+08:00'));task=await f.service.call('tasks.save',edit(task,{completed:true}));expect(task.completedDate).toBe('2028-05-24');
  const disk=await Store.open(f.store.file);try{expect(disk.get('tasks',task.id)).toEqual(task);}finally{disk.close();}
 });
 it('rejects invalid or empty completion dates and stale versions without changing a task',async()=>{
  clock();const f=await fixture(),task=await f.service.call('tasks.save',{...fields,completed:true});
  for(const completedDate of [null,'','2028-02-30','2027-02-29','2028-05-20T00:00:00Z',5])await expect(f.service.call('tasks.save',edit(task,{completedDate}))).rejects.toMatchObject({code:'INVALID'});
  await expect(f.service.call('tasks.save',edit(task,{expectedVersion:0,completedDate:'2028-05-18'}))).rejects.toMatchObject({code:'INVALID'});
  const changed=await f.service.call('tasks.save',edit(task,{completedDate:'2028-05-18'}));await expect(f.service.call('tasks.save',edit(task,{completedDate:'2028-05-17'}))).rejects.toMatchObject({code:'CONFLICT'});expect(f.store.get('tasks',task.id)).toEqual(changed);
 });
 it('rolls back completion changes on persistence failure',async()=>{
  clock();let fail=false;const f=await fixture(async(file,data)=>{if(fail)throw new Error('completion disk failure');await atomicWrite(file,data);});
  const task=await f.service.call('tasks.save',fields),before=await fs.readFile(f.store.file);fail=true;
  await expect(f.service.call('tasks.save',edit(task,{completed:true}))).rejects.toThrow('completion disk failure');expect(f.store.get('tasks',task.id)).toEqual(task);expect(await fs.readFile(f.store.file)).toEqual(before);
 });
 it('migrates historical completed records to their original date, including deleted tasks, idempotently',async()=>{
  clock();const f=await fixture(),legacy=[false,true].flatMap(completed=>[null,'2025-02-02T00:00:00.000Z'].map(deletedAt=>({...identity(),...fields,priority:'P2',completed,deletedAt}))),explicit={...identity(),...fields,priority:'P1',completed:true,completedDate:'2028-05-01',deletedAt:null};
  await f.store.transaction(()=>{for(const task of [...legacy,explicit])f.store.put('tasks',task);});await f.service.recover();await f.service.recover();
  const expected=[...legacy.map(task=>({...task,completedDate:task.completed?task.date:null})),explicit];expect(f.store.list('tasks')).toEqual(expected);
  const disk=await Store.open(f.store.file);try{expect(disk.list('tasks')).toEqual(expected);}finally{disk.close();}
 });
 it('applies the same completion transition to AI actions and preserves dates on update and reschedule',async()=>{
  clock();const f=await fixture(),c=await f.service.call('conversations.create',{projectId:null,date:fields.date,model:null});
  async function apply(actions:TaskAction[],taskIds:string[]=[]){const draft:Draft={...identity(),conversationId:c.id,messageId:randomUUID(),projectId:null,taskIds,actions,status:'pending',appliedTaskIds:[]};await f.store.transaction(()=>f.store.put('drafts',draft));return f.service.call('drafts.apply',{id:draft.id,expectedVersion:draft.version});}
  const created=await apply([{type:'create',title:fields.title,date:fields.date,projectId:null}]);if((created.kind==='file'||created.kind==='component'))throw Error('Expected task draft');let task=f.store.get<Task>('tasks',created.appliedTaskIds[0])!;expect(task.completedDate).toBeNull();
  for(const changes of [{type:'complete',completed:true},{type:'update',title:'合成更新'},{type:'reschedule',date:'2028-06-01'}] as const){await apply([{...changes,taskId:task.id,expectedVersion:task.version}],[task.id]);task=f.store.get<Task>('tasks',task.id)!;expect(task.completedDate).toBe('2028-05-20');}
  await apply([{type:'complete',completed:false,taskId:task.id,expectedVersion:task.version}],[task.id]);task=f.store.get<Task>('tasks',task.id)!;expect(task).toMatchObject({date:'2028-06-01',completedDate:null});
 });
 it('uses completion dates for calendar membership with a safe legacy fallback',()=>{
  const record={...identity(),...fields,priority:'P2' as const,deletedAt:null,completedDate:'2028-05-18'};
  expect(dates.taskCalendarDate(record)).toBe(fields.date);expect(dates.taskCalendarDate({...record,completed:true})).toBe('2028-05-18');
  const {completedDate,...legacy}=record;expect(dates.taskCalendarDate({...legacy,completed:true})).toBe(fields.date);
 });
 it('sends completion-day calendar context across projects and excludes the old day and deleted records',async()=>{
  const f=await fixture(),project=await f.service.call('projects.save',{name:'合成项目',description:'',directory:f.dir});
  const included=await f.service.call('tasks.save',{...fields,date:'2099-05-22',completed:true,completedDate:'2099-05-20',projectId:project.id});
  await f.service.call('tasks.save',{...fields,date:'2099-05-20',completed:true,completedDate:'2099-05-19'});
  const removed=await f.service.call('tasks.save',{...fields,date:'2099-05-20'});await f.service.call('tasks.delete',{id:removed.id,expectedVersion:removed.version});
  const source=await f.service.call('sources.save',{name:'合成模型源',baseUrl:'https://model.test/v1',models:[{id:'synthetic',name:'合成模型',supportsTools:false}]}),model={sourceId:source.id,modelId:'synthetic'},c=await f.service.call('conversations.create',{projectId:null,date:'2099-05-20',model});
  const request=vi.fn(async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'合成回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));vi.stubGlobal('fetch',request);
  await f.service.call('chat.send',{conversationId:c.id,text:'合成问题',model,context:{...emptyContext(),date:'2099-05-20',calendarTasks:true}});await vi.waitFor(()=>expect(f.store.list<any>('requests')[0]?.status).toBe('complete'));
  const body=JSON.parse((request.mock.calls[0] as unknown as [unknown,RequestInit])[1].body as string),system=body.messages.find((message:any)=>message.role==='system').content;
  const rows=JSON.parse(system.match(/Calendar tasks for [^\n]+\n([^\n]+)/)[1]);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:included.id,date:'2099-05-22',completedDate:'2099-05-20',projectName:project.name});
 });
 it('restores old and new backups with completion dates and keeps validation before transformation',async()=>{
  clock();const f=await fixture(),task=await f.service.call('tasks.save',{...fields,completed:true,completedDate:'2028-05-18'}),original=await f.service.backup(),file=path.join(f.dir,'completion-backup.json');f.setBackup(file);
  const rehash=(b:any)=>{b.sha256=createHash('sha256').update(JSON.stringify({format:b.format,version:b.version,rows:b.rows,packages:b.packages,...(b.version===2?{skillFiles:b.skillFiles}:{})})).digest('hex');};
  for(const legacy of [false,true]){const backup=structuredClone(original);if(legacy)delete backup.rows.tasks[0].completedDate;rehash(backup);await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));try{expect(copy.get('tasks',task.id)).toEqual({...task,completedDate:legacy?fields.date:'2028-05-18'});}finally{copy.close();}}
  const tampered=structuredClone(original);tampered.rows.tasks[0].completedDate='2028-05-17';await fs.writeFile(file,JSON.stringify(tampered));await expect(f.service.call('data.validate',{})).rejects.toThrow('校验和');
  for(const completedDate of [null,'2028-02-30','',5]){const backup=structuredClone(original);backup.rows.tasks[0].completedDate=completedDate;rehash(backup);await fs.writeFile(file,JSON.stringify(backup));await expect(f.service.call('data.validate',{})).rejects.toMatchObject({code:'INVALID'});}
  expect(f.store.get('tasks',task.id)).toEqual(task);
 });
});
