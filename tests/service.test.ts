import {describe,it,expect,afterEach,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {Settings} from 'luxon';
import {Store,atomicWrite} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {AppService} from '../src/main/service';
import {Meetings} from '../src/main/meetings';
import {McpServer as SdkMcpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {emptyContext,type AppEvent, type Source,type ContextSelection,type Task,type TaskAction,type Draft} from '../src/shared/types';
const {createMockServer}=require('../scripts/mock-model.cjs');
const root=path.resolve('test-data');
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllGlobals();});
async function fixture(persist=atomicWrite){await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'service-'));let pluginPath:string|null=null,backupPath:string|null=null,projectPath:string|null=null;const opened:string[]=[];const store=await Store.open(path.join(dir,'workday.sqlite'),persist);const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('sealed:'+s),decryptString:b=>b.toString().slice(7)});await credentials.init();const service=new AppService(store,credentials,{openProject:async()=>projectPath,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>pluginPath,saveBackup:async()=>backupPath,openBackup:async()=>backupPath,openExternal:async url=>{opened.push(url);},openDirectory:async()=>{}},dir);cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});return {service,store,credentials,dir,opened,setProject:(p:string|null)=>projectPath=p,setPlugin:(p:string)=>pluginPath=p,setBackup:(p:string)=>backupPath=p};}
async function mock(){const m=createMockServer();await new Promise<void>((r,reject)=>{m.server.once('error',reject);m.server.listen(0,'127.0.0.1',r);});cleanup.push(()=>new Promise<void>(r=>{m.server.closeAllConnections();m.server.close(()=>r());}));return {...m,url:`http://127.0.0.1:${m.server.address().port}/v1`};}
async function httpMcp(label:string){let calls=0;const server=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const sdk=new SdkMcpServer({name:label,version:'1.0.0'});sdk.tool('lookup','local read-only tool',{topic:z.string()},async({topic})=>({content:[{type:'text',text:JSON.stringify({label,topic,calls:++calls})}]}));const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});await sdk.connect(transport);await transport.handleRequest(req,res,raw?JSON.parse(raw):undefined);res.on('close',()=>void sdk.close());}catch{res.writeHead(500);res.end();}});await new Promise<void>((r,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',r);});cleanup.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));return {url:`http://127.0.0.1:${(server.address() as any).port}/mcp`,get calls(){return calls;}};}
async function source(service:AppService,url:string,secret?:string){return service.call('sources.save',{name:'本地模拟 '+url,baseUrl:url,models:[{id:'workday-mock',name:'同名模型',supportsTools:true}],secret});}
it('reads meetings without persisting calendar content or emitting business-state changes',async()=>{
 const f=await fixture(),before=await f.service.backup(),events:AppEvent[]=[];
 const input={startDate:'2026-09-27',endDate:'2026-11-08',timezone:'Asia/Shanghai'};
 const output={...input,status:'ready' as const,message:null,meetings:[{id:'synthetic-calendar-only',title:'CALENDAR_ONLY_SYNTHETIC',start:'2026-10-16T09:00:00+08:00',end:'2026-10-16T10:00:00+08:00',allDay:false,startDate:null,endDate:null}]};
 const spy=vi.spyOn(Meetings.prototype,'query').mockResolvedValue(output),unsubscribe=f.service.subscribe(e=>events.push(e));
 try{
  expect(await f.service.call('meetings.query',input)).toEqual(output);expect(spy).toHaveBeenCalledWith(input);
  expect((await f.service.backup()).rows).toEqual(before.rows);expect(JSON.stringify(await f.service.call('state.get',{}))).not.toContain('CALENDAR_ONLY_SYNTHETIC');expect(events).toEqual([]);
  await expect(f.service.call('meetings.query',{...input,calendarName:'other'})).rejects.toThrow('参数');expect(spy).toHaveBeenCalledTimes(1);
 }finally{unsubscribe();spy.mockRestore();}
});
it('saves anchored biweekly schedules, recovers missed slots once and restores old/new specs paused',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
 const fetch=vi.fn(()=>{throw new Error('Schedule lifecycle must not contact a model');});vi.stubGlobal('fetch',fetch);
 try{
  const f=await fixture(),src=await source(f.service,'https://model.example/v1');
  const input={name:'双周报',prompt:'fixture',projectId:null,model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext(),spec:{kind:'biweekly' as const,startDate:'2026-12-25',time:'09:00',timezone:'Asia/Shanghai'}};
  let s=await f.service.call('schedules.save',input);expect(s).toMatchObject({enabled:false,status:'paused',spec:input.spec,nextRunAt:'2026-12-25T01:00:00.000Z'});
  s=await f.service.call('schedules.toggle',{id:s.id,expectedVersion:s.version,enabled:true});expect(s.status).toBe('active');
  s=await f.service.call('schedules.toggle',{id:s.id,expectedVersion:s.version,enabled:false});
  vi.setSystemTime(new Date('2026-12-26T00:00:00Z'));
  s=await f.service.call('schedules.toggle',{id:s.id,expectedVersion:s.version,enabled:true});expect(s.nextRunAt).toBe('2027-01-08T01:00:00.000Z');
  s=await f.service.call('schedules.save',{...input,id:s.id,expectedVersion:s.version,spec:{...input.spec,startDate:'2027-01-01'}});expect(s.enabled).toBe(false);
  s=await f.service.call('schedules.toggle',{id:s.id,expectedVersion:s.version,enabled:true});
  vi.setSystemTime(new Date('2027-01-30T00:00:00Z'));await f.service.recover();await f.service.recover();
  const runs=await f.service.call('schedules.runs',{id:s.id});expect(runs.map(r=>r.scheduledFor).sort()).toEqual(['2027-01-01T01:00:00.000Z','2027-01-15T01:00:00.000Z','2027-01-29T01:00:00.000Z']);expect(runs.every(r=>r.status==='missed')).toBe(true);
  expect((await f.service.call('state.get',{})).schedules[0].nextRunAt).toBe('2027-02-12T01:00:00.000Z');
  for(const spec of [{kind:'daily' as const,time:'09:00',timezone:'Asia/Shanghai'},{kind:'weekly' as const,weekday:1,time:'09:00',timezone:'Asia/Shanghai'},{kind:'once' as const,date:'2027-02-01',time:'09:00',timezone:'Asia/Shanghai'}])await f.service.call('schedules.save',{...input,spec});
  const backup=await f.service.backup(),file=path.join(f.dir,'biweekly-backup.json');f.setBackup(file);await fs.writeFile(file,JSON.stringify(backup));
  const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));
  try{const rows=copy.list<any>('schedules');expect(rows).toHaveLength(4);expect(rows.every(s=>!s.enabled&&s.status==='paused'&&s.nextRunAt===null)).toBe(true);expect(rows.find(row=>row.id===s.id)?.spec).toEqual({...input.spec,startDate:'2027-01-01'});}finally{copy.close();}
  expect(fetch).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});
function event(service:AppService,requestId:string,expected='chatDone'){return new Promise<AppEvent>((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('chat event timeout'));},8000);const off=service.subscribe(e=>{if(e.type==='stateChanged'||e.requestId!==requestId||!['chatDone','chatFailed','chatCancelled'].includes(e.type))return;clearTimeout(timer);off();if(e.type!==expected)reject(new Error(JSON.stringify(e)));else resolve(e);});});}
describe('WorkDay operations',()=>{
 it('reports model catalog credential failures without leaking details or changing the source',async()=>{
  const f=await fixture(),src=await source(f.service,'https://model.example/v1');const sensitive='private-model-credential-error';const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  const spy=vi.spyOn(f.credentials,'get').mockImplementation(()=>{throw new Error(sensitive);});
  try{const error=await f.service.call('sources.models',{id:src.id}).catch(error=>error);expect(error).toMatchObject({code:'CREDENTIAL',message:'无法读取此模型源的已保存 API Key，请在编辑配置中重新填写'});expect(String(error)).not.toContain(sensitive);expect(error.cause).toBeUndefined();expect(fetchMock).not.toHaveBeenCalled();expect((await f.service.call('state.get',{})).sources[0]).toEqual(src);}finally{spy.mockRestore();}
 });
 it('reports model catalog network and response failures without leaking details or replacing the old catalog',async()=>{
  const f=await fixture(),src=await source(f.service,'https://model.example/v1');const sensitive='private-model-response-error';
  const failures=[{reply:()=>{throw new TypeError(sensitive);},message:'网络连接失败'},{reply:()=>{throw new TypeError(sensitive,{cause:{code:'EBADF'}});},message:'本机网络连接失败（EBADF）'},{reply:()=>new Response(sensitive),message:'模型目录'},...['null','{"data":{}}','{"data":[null]}'].map(body=>({reply:()=>new Response(body),message:'模型目录'}))];
  for(const failure of failures){const fetchMock=vi.fn(async()=>failure.reply());vi.stubGlobal('fetch',fetchMock);const error=await f.service.call('sources.models',{id:src.id}).catch(error=>error);expect(error).toMatchObject({code:'REMOTE',message:expect.stringContaining(failure.message)});expect(String(error)).not.toContain(sensitive);expect(error.cause).toBeUndefined();expect(fetchMock).toHaveBeenCalledWith(src.baseUrl+'/models',expect.objectContaining({redirect:'error'}));expect((await f.service.call('state.get',{})).sources[0]).toEqual(src);}
 });
 it('fetches and saves a standard model catalog for a source with no manual models',async()=>{
  const f=await fixture(),src=await f.service.call('sources.save',{name:'Empty catalog',baseUrl:'https://model.example/v1',models:[],secret:'model-catalog-only-fake-key'});
  const fetchMock=vi.fn(async(url:string,init:RequestInit)=>{expect(url).toBe(src.baseUrl+'/models');expect(init.method??'GET').toBe('GET');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer model-catalog-only-fake-key');expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');return new Response(JSON.stringify({object:'list',data:[{id:'model-a',object:'model'},{id:'model-b',object:'model'}]}));});vi.stubGlobal('fetch',fetchMock);
  const catalog=await f.service.call('sources.models',{id:src.id});expect(fetchMock).toHaveBeenCalledTimes(1);expect(catalog.models).toEqual([{id:'model-a',name:'model-a',supportsTools:false},{id:'model-b',name:'model-b',supportsTools:false}]);expect((await f.service.call('state.get',{})).sources[0]).toEqual(catalog);
 });
 it('supports authenticated remote-style HTTP across catalog/test/stream/retry/schedule and safe restore (locally routed fixture)',async()=>{
  const f=await fixture(),m=await mock(),actualFetch=globalThis.fetch;const remote='http://model-http.example:8317/v1';const requests:{url:string,authorization:string|null,redirect:string|undefined}[]=[];
  vi.stubGlobal('fetch',async(input:any,init?:RequestInit)=>{const url=String(input);expect(url.startsWith(remote+'/')).toBe(true);requests.push({url,authorization:new Headers(init?.headers).get('Authorization'),redirect:init?.redirect});return actualFetch(url.replace(remote,m.url),init);});
  let src=await source(f.service,remote,'model-http-only-fake-key');expect(src.baseUrl).toBe(remote);expect(src.credentialConfigured).toBe(true);
  src=await f.service.call('sources.models',{id:src.id});expect(src.models[0].id).toBe('workday-mock');src=await f.service.call('sources.test',{id:src.id,modelId:'workday-mock'});expect(src.testStatus).toBe('连接成功');
  const model={sourceId:src.id,modelId:'workday-mock'},c=await f.service.call('conversations.create',{projectId:null,date:null,model});const sent=await f.service.call('chat.send',{conversationId:c.id,text:'HTTP 失败一次',model,context:emptyContext()});await event(f.service,sent.requestId,'chatFailed');const retry=await f.service.call('chat.retry',{conversationId:c.id,userMessageId:sent.userMessageId});await event(f.service,retry.requestId);expect((await f.service.call('conversations.history',{id:c.id})).filter(m=>m.role==='user')).toHaveLength(1);
  const schedule=await f.service.call('schedules.save',{name:'HTTP 摘要',prompt:'HTTP 计划结果',projectId:null,model,context:emptyContext(),spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});const run=await f.service.call('schedules.run',{id:schedule.id,triggerId:randomUUID()});await vi.waitFor(async()=>{expect((await f.service.call('schedules.runs',{id:schedule.id}))[0].status).toBe('success');});expect(run.conversationId).not.toBeNull();
  expect(requests.map(r=>r.url)).toEqual([remote+'/models',...Array(4).fill(remote+'/chat/completions')]);expect(requests.every(r=>r.authorization==='Bearer model-http-only-fake-key'&&r.redirect==='error')).toBe(true);
  expect(JSON.stringify(await f.service.call('state.get',{}))).not.toContain('model-http-only-fake-key');expect(await fs.readFile(path.join(f.dir,'credentials.json'),'utf8')).not.toContain('model-http-only-fake-key');const backup=await f.service.backup();expect(JSON.stringify(backup)).not.toContain('model-http-only-fake-key');
  const file=path.join(f.dir,'http-backup.json');f.setBackup(file);await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{});const restored=await f.service.call('data.restoreCopy',{token:preview!.token});const copy=await Store.open(path.join(restored.path,'workday.sqlite'));expect(copy.list<any>('sources')[0]).toMatchObject({baseUrl:remote,enabled:false,credentialConfigured:false});expect(copy.list<any>('schedules')[0].enabled).toBe(false);copy.close();expect((await f.service.call('state.get',{})).sources[0].enabled).toBe(true);
  const reopened=new Credentials(path.join(f.dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('sealed:'+s),decryptString:b=>b.toString().slice(7)});await reopened.init();expect(reopened.get('source:'+src.id)).toBe('model-http-only-fake-key');
 });
 it('rejects malformed HTTP sources before writing rows or credentials and preserves non-model boundaries',async()=>{
  const f=await fixture();for(const url of ['http://model.test/v1?','http://model.test/v1#','http://user:secret@model.test/v1','http://model.test:99999/v1','ftp://model.test/v1'])await expect(source(f.service,url,'model-http-only-fake-key')).rejects.toThrow();expect((await f.service.call('state.get',{})).sources).toHaveLength(0);await expect(fs.stat(path.join(f.dir,'credentials.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(f.service.call('mcp.save',{name:'remote',transport:'http',url:'http://model-http.example:8317/mcp',command:'',args:[],secret:'model-http-only-fake-key'})).rejects.toThrow('回环');
  const pkg=path.join(f.dir,'http-plugin');await fs.mkdir(pkg);await fs.writeFile(path.join(pkg,'workday-plugin.json'),JSON.stringify({id:'http-test',name:'HTTP test',version:'1.0.0',appVersion:'0.1',skills:[],mcp:['mcp.json']}));await fs.writeFile(path.join(pkg,'mcp.json'),JSON.stringify({name:'remote',transport:'http',url:'http://model-http.example:8317/mcp',command:'',args:[]}));f.setPlugin(pkg);await expect(f.service.call('plugins.preview',{})).rejects.toThrow('回环');
  const m=await mock();await source(f.service,'http://model-http.example:8317/v1');let server=await f.service.call('mcp.save',{name:'loopback',transport:'http',url:m.url,command:'',args:[]});const good=await f.service.backup();const file=path.join(f.dir,'bad-backup.json');f.setBackup(file);
  for(const change of [(b:any)=>b.rows.sources[0].baseUrl='http://model.test/v1?',(b:any)=>b.rows.mcpServers.find((s:any)=>s.id===server.id).url='http://model-http.example:8317/mcp']){const bad=structuredClone(good);change(bad);bad.sha256=createHash('sha256').update(JSON.stringify({format:bad.format,version:bad.version,rows:bad.rows,packages:bad.packages,...(bad.version===2?{skillFiles:bad.skillFiles}:{})})).digest('hex');await fs.writeFile(file,JSON.stringify(bad));await expect(f.service.call('data.validate',{})).rejects.toThrow();}
 });
 it('does not undo or report a durable task write as failed when a UI subscriber closes',async()=>{const f=await fixture();f.service.subscribe(()=>{throw new Error('window closed');});const task=await f.service.call('tasks.save',{title:'已提交',notes:'',date:'2026-10-12',projectId:null,completed:false});expect((await f.service.call('state.get',{})).tasks[0].id).toBe(task.id);});
 it('sends only selected document excerpt and Skill version, and rejects other-project or oversized context',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const p=await f.service.call('projects.save',{name:'上下文项目',description:'仅本项目简介',directory:f.dir});const selected=await f.service.call('knowledge.save',{name:'明确选择',content:'公开片段。未选择的剩余内容。',projectId:p.id});const unselected=await f.service.call('knowledge.save',{name:'未选择',content:'UNSELECTED_PRIVATE_TEST',projectId:p.id});const skill=await f.service.call('skills.save',{name:'摘要',description:'摘要工作流',content:'SKILL_SELECTED_TEST'});const c=await f.service.call('conversations.create',{projectId:p.id,date:null,model:null});const ctx={...emptyContext(),knowledgeRefs:[{id:selected.id,version:selected.version,excerpt:'公开片段。'}],skillRef:{id:skill.id,version:skill.version}};const sent=await f.service.call('chat.send',{conversationId:c.id,text:'上下文测试',model:{sourceId:src.id,modelId:'workday-mock'},context:ctx});await event(f.service,sent.requestId);const payload=JSON.stringify(m.requests[0].body);expect(payload).toContain('公开片段');expect(payload).toContain('SKILL_SELECTED_TEST');expect(payload).not.toContain('未选择的剩余');expect(payload).not.toContain('UNSELECTED_PRIVATE_TEST');expect(payload).not.toContain(f.dir);const user=(await f.service.call('conversations.history',{id:c.id})).find(m=>m.role==='user')!;expect((user.snapshot as any).context.skillRef.version).toBe(skill.version);const other=await f.service.call('conversations.create',{projectId:null,date:null,model:null});await expect(f.service.call('chat.send',{conversationId:other.id,text:'不应发送',model:{sourceId:src.id,modelId:'workday-mock'},context:ctx})).rejects.toThrow('归属');const big=await f.service.call('knowledge.save',{name:'很长',content:'X'.repeat(70000),projectId:p.id});await expect(f.service.call('chat.send',{conversationId:c.id,text:'不应截断',model:{sourceId:src.id,modelId:'workday-mock'},context:{...emptyContext(),knowledgeRefs:[{id:big.id,version:big.version}]}})).rejects.toThrow('过长');});
 it('keeps source names unique and records failed test status without changing config binding',async()=>{const f=await fixture();const http=createServer((_req,res)=>{res.writeHead(500);res.end();});await new Promise<void>((r,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',r);});cleanup.push(()=>new Promise<void>(r=>{http.closeAllConnections();http.close(()=>r());}));const url=`http://127.0.0.1:${(http.address() as any).port}/v1`;const src=await source(f.service,url);await expect(source(f.service,url)).rejects.toThrow('名称');await expect(f.service.call('sources.test',{id:src.id,modelId:'workday-mock'})).rejects.toThrow('HTTP 500');const tested=(await f.service.call('state.get',{})).sources[0];expect(tested.testStatus).toContain('测试失败');expect(tested.testedAt).not.toBeNull();expect(tested.configVersion).toBe(src.configVersion);});
 it('isolates HTTP servers with the same tool name and respects capability-version changes',async()=>{const f=await fixture();const a=await httpMcp('server-a'),b=await httpMcp('server-b');const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});async function configure(url:string){let m=await f.service.call('mcp.save',{name:url,transport:'http',url,command:'',args:[]});m=await f.service.call('mcp.toggle',{id:m.id,expectedVersion:m.version,enabled:true});return f.service.call('mcp.discover',{id:m.id});}const ma=await configure(a.url),mb=await configure(b.url);for(const m of [ma,mb])await f.service.call('grants.save',{scopeType:'conversation',scopeId:c.id,mcpId:m.id,configVersion:m.configVersion,capabilityType:'tool',capabilityName:'lookup',readOnly:true,allowedSchema:{type:'object',properties:{topic:{const:'WorkDay'}},required:['topic'],additionalProperties:false}});const result=await f.service.call('mcp.call',{id:mb.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'WorkDay'}});expect(result).toContain('server-b');expect(a.calls).toBe(0);expect(b.calls).toBe(1);const again=await f.service.call('mcp.discover',{id:mb.id});expect(again.configVersion).toBe(mb.configVersion);const edited=await f.service.call('mcp.save',{id:mb.id,expectedVersion:again.version,name:'changed',transport:'http',url:mb.url,command:'',args:[]});await f.service.call('mcp.toggle',{id:edited.id,expectedVersion:edited.version,enabled:true});await f.service.call('mcp.discover',{id:edited.id});await expect(f.service.call('mcp.call',{id:edited.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'WorkDay'}})).rejects.toThrow('授权');});
 it('persists task lifecycle, version conflicts, project null and move without history loss',async()=>{const f=await fixture();const s=f.service;const task=await s.call('tasks.save',{title:'测试待办',notes:'备注',date:'2028-02-29',projectId:null,completed:false});await expect(s.call('tasks.save',{id:task.id,expectedVersion:2,title:'bad',notes:'',date:'2028-02-29',projectId:null,completed:true})).rejects.toThrow('修改');const changed=await s.call('tasks.save',{id:task.id,expectedVersion:task.version,title:task.title,notes:task.notes,date:'2028-03-01',projectId:null,completed:true});const deleted=await s.call('tasks.delete',{id:task.id,expectedVersion:changed.version});expect(deleted.deletedAt).not.toBeNull();await s.call('tasks.restore',{id:task.id,expectedVersion:deleted.version});const reopened=await Store.open(path.join(f.dir,'workday.sqlite'));expect(reopened.list<any>('tasks')[0].date).toBe('2028-03-01');reopened.close();
  const project=await s.call('projects.save',{name:'WorkDay',description:'上下文',directory:f.dir});const c=await s.call('conversations.create',{projectId:null,date:null,model:null});expect(c.projectId).toBeNull();const moved=await s.call('conversations.move',{id:c.id,expectedVersion:c.version,projectId:project.id});expect(moved.projectId).toBe(project.id);expect(moved.context).toEqual(emptyContext());const back=await s.call('conversations.move',{id:c.id,expectedVersion:moved.version,projectId:null});expect(back.id).toBe(c.id);await expect(s.call('conversations.create',{projectId:'',date:null,model:null})).rejects.toThrow('参数无效');
 });
 it('isolates same model IDs by source; retries keep one user message and complete history only',async()=>{const f=await fixture();const m1=await mock(),m2=await mock();const s1=await source(f.service,m1.url,'fake-test-token'),s2=await source(f.service,m2.url);const c=await f.service.call('conversations.create',{projectId:null,date:null,model:{sourceId:s1.id,modelId:'workday-mock'}});const sent=await f.service.call('chat.send',{conversationId:c.id,text:'失败一次',model:{sourceId:s1.id,modelId:'workday-mock'},context:emptyContext()});await event(f.service,sent.requestId,'chatFailed');const retry=await f.service.call('chat.retry',{conversationId:c.id,userMessageId:sent.userMessageId});expect(retry.requestId).not.toBe(sent.requestId);await event(f.service,retry.requestId);expect((await f.service.call('conversations.history',{id:c.id})).filter(m=>m.role==='user')).toHaveLength(1);
  const next=await f.service.call('chat.send',{conversationId:c.id,text:'第二个问题',model:{sourceId:s2.id,modelId:'workday-mock'},context:emptyContext()});await event(f.service,next.requestId);expect(m1.requests).toHaveLength(2);expect(m2.requests).toHaveLength(1);expect(m1.requests[0].authorization).toBe('Bearer fake-test-token');expect(m2.requests[0].authorization).toBeUndefined();expect(m2.requests[0].body.messages.filter((m:any)=>m.role==='user')).toHaveLength(2);
  const state=await f.service.call('state.get',{});expect(JSON.stringify(state)).not.toContain('fake-test-token');const backup=await f.service.backup();expect(JSON.stringify(backup)).not.toContain('fake-test-token');expect(backup.rows.sources.every(s=>!s.credentialConfigured&&!s.enabled)).toBe(true);
 });
 it('stops streaming, disallows move while active, and accepts draft once with atomic conflict rollback',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const c=await f.service.call('conversations.create',{projectId:null,date:'2026-10-12',model:null});const sent=await f.service.call('chat.send',{conversationId:c.id,text:'慢回复',model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext()});const current=(await f.service.call('state.get',{})).conversations.find(x=>x.id===c.id)!;await expect(f.service.call('conversations.move',{id:c.id,expectedVersion:current.version,projectId:null})).rejects.toThrow('生成中');const stopped=event(f.service,sent.requestId,'chatCancelled');await f.service.call('chat.cancel',{requestId:sent.requestId});await stopped;
  const draftSent=await f.service.call('chat.send',{conversationId:c.id,text:'给我一个草案',model:{sourceId:src.id,modelId:'workday-mock'},context:{...emptyContext(),date:'2026-10-12'}});await event(f.service,draftSent.requestId);const d=(await f.service.call('state.get',{})).drafts[0];if((d.kind==='file'||d.kind==='component'))throw Error('Expected task draft');expect(d.actions[0].type).toBe('create');const applied=await f.service.call('drafts.apply',{id:d.id,expectedVersion:d.version});await f.service.call('drafts.apply',{id:d.id,expectedVersion:d.version});expect((await f.service.call('state.get',{})).tasks).toHaveLength(1);expect(applied.status).toBe('applied');
  const task=(await f.service.call('state.get',{})).tasks[0];const invalid={...d,id:randomUUID(),status:'pending' as const,version:1,taskIds:[task.id],actions:[{type:'create' as const,title:'不得落盘',date:task.date,projectId:null},{type:'complete' as const,taskId:task.id,expectedVersion:99,completed:true}]};await f.store.transaction(()=>f.store.put('drafts',invalid));await expect(f.service.call('drafts.apply',{id:invalid.id,expectedVersion:1})).rejects.toThrow('修改');expect((await f.service.call('state.get',{})).tasks).toHaveLength(1);
 });
 it('validates a backup even when tampered shapes have a recomputed checksum and restores safe copy',async()=>{const f=await fixture();const task=await f.service.call('tasks.save',{title:'原数据保留',notes:'',date:'2026-10-12',projectId:null,completed:false});const file=path.join(f.dir,'backup.json');f.setBackup(file);await f.service.call('data.backup',{});const original=JSON.parse(await fs.readFile(file,'utf8'));const oversized=path.join(f.dir,'oversized-backup.json');const h=await fs.open(oversized,'w');await h.truncate(384*1024*1024+1);await h.close();f.setBackup(oversized);await expect(f.service.call('data.validate',{})).rejects.toThrow('384MiB');f.setBackup(file);const bad=structuredClone(original);delete bad.rows.tasks[0].title;bad.sha256=createHash('sha256').update(JSON.stringify({format:bad.format,version:bad.version,rows:bad.rows,packages:bad.packages,...(bad.version===2?{skillFiles:bad.skillFiles}:{})})).digest('hex');await fs.writeFile(file,JSON.stringify(bad));await expect(f.service.call('data.validate',{})).rejects.toThrow('参数无效');await fs.writeFile(file,JSON.stringify(original));const preview=await f.service.call('data.validate',{});const result=await f.service.call('data.restoreCopy',{token:preview!.token});const copy=await Store.open(path.join(result.path,'workday.sqlite'));expect(copy.list<any>('tasks')[0].id).toBe(task.id);expect(copy.list('grants')).toHaveLength(0);copy.close();expect((await f.service.call('state.get',{})).tasks[0].id).toBe(task.id);
 });
 it('preserves secret from first successful concurrent edit when second conflicts',async()=>{const f=await fixture();const m=await mock();const s=await source(f.service,m.url,'original');const input={id:s.id,expectedVersion:s.version,name:s.name,baseUrl:s.baseUrl,models:s.models};const results=await Promise.allSettled([f.service.call('sources.save',{...input,secret:'first-success'}),f.service.call('sources.save',{...input,secret:'second-conflict'})]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(f.credentials.get('source:'+s.id)).toBe('first-success');});
 it('authorizes real stdio MCP, resumes after tool success without repeated call, and revokes',async()=>{const f=await fixture();const mockModel=await mock();const sourceValue=await source(f.service,mockModel.url);const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});let server=await f.service.call('mcp.save',{name:'本地测试',transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-mcp.cjs')],url:''});server=await f.service.call('mcp.toggle',{id:server.id,expectedVersion:server.version,enabled:true});server=await f.service.call('mcp.discover',{id:server.id});expect(server.tools[0].name).toBe('lookup');expect(server.resources[0].uri).toBe('workday://reference');expect(server.prompts[0].name).toBe('brief');await expect(f.service.call('mcp.call',{id:server.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'WorkDay'}})).rejects.toThrow('授权');const grant=await f.service.call('grants.save',{scopeType:'conversation',scopeId:c.id,mcpId:server.id,configVersion:server.configVersion,capabilityType:'tool',capabilityName:'lookup',readOnly:true,allowedSchema:{type:'object',properties:{topic:{const:'WorkDay'}},required:['topic'],additionalProperties:false}});await expect(f.service.call('mcp.call',{id:server.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'other'}})).rejects.toThrow('范围');
  const ctx:ContextSelection={...emptyContext(),mcpRefs:[{id:server.id,configVersion:server.configVersion,capabilityNames:['lookup']}]};const sent=await f.service.call('chat.send',{conversationId:c.id,text:'工具 回复失败一次',model:{sourceId:sourceValue.id,modelId:'workday-mock'},context:ctx});await event(f.service,sent.requestId,'chatFailed');const retry=await f.service.call('chat.retry',{conversationId:c.id,userMessageId:sent.userMessageId});await event(f.service,retry.requestId);const messages=await f.service.call('conversations.history',{id:c.id});expect(messages.filter(m=>m.role==='tool')).toHaveLength(1);expect(messages.filter(m=>m.role==='tool')[0].content).toContain('\\"calls\\":1');await f.service.call('grants.revoke',{id:grant.id,expectedVersion:grant.version});await expect(f.service.call('mcp.call',{id:server.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'WorkDay'}})).rejects.toThrow('授权');
 });
 it('installs previewed local package, uninstalls owner components only and keeps independent skill',async()=>{const f=await fixture();const independent=await f.service.call('skills.save',{name:'独立',description:'独立指令',content:'Please summarize.'});const pkg=path.join(f.dir,'input-package');await fs.mkdir(path.join(pkg,'skills','summary'),{recursive:true});await fs.writeFile(path.join(pkg,'workday-plugin.json'),JSON.stringify({id:'test-package',name:'测试包',version:'1.0.0',description:'本地测试',appVersion:'0.1',skills:['skills/summary/SKILL.md'],mcp:['mcp.json']}));await fs.writeFile(path.join(pkg,'skills/summary/SKILL.md'),'---\nname: summary\ndescription: Summarize selected items\n---\nPlease summarize only selected data.');await fs.writeFile(path.join(pkg,'mcp.json'),JSON.stringify({name:'测试连接',transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-mcp.cjs')],url:''}));f.setPlugin(pkg);const preview=await f.service.call('plugins.preview',{});expect(preview?.components).toHaveLength(2);const plugin=await f.service.call('plugins.install',{token:preview!.token});const state=await f.service.call('state.get',{});expect(state.mcpServers[0].enabled).toBe(false);expect(state.grants).toHaveLength(0);await f.service.call('plugins.uninstall',{id:plugin.id,expectedVersion:plugin.version});const after=await f.service.call('state.get',{});expect(after.skills.map(s=>s.id)).toEqual([independent.id]);expect(after.mcpServers).toHaveLength(0);expect(after.plugins).toHaveLength(0);
 });
 it('runs fixed-model schedule once per manual trigger, keeps no-project results, pauses on source changes',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const schedule=await f.service.call('schedules.save',{name:'摘要',prompt:'生成摘要',projectId:null,model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext(),spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});const trigger=randomUUID();const first=await f.service.call('schedules.run',{id:schedule.id,triggerId:trigger});const second=await f.service.call('schedules.run',{id:schedule.id,triggerId:trigger});expect(second.id).toBe(first.id);expect(first.conversationId).not.toBeNull();await new Promise(r=>setTimeout(r,500));const runs=await f.service.call('schedules.runs',{id:schedule.id});expect(runs).toHaveLength(1);expect(runs[0].status).toBe('success');const c=(await f.service.call('state.get',{})).conversations.find(c=>c.id===first.conversationId)!;expect(c.projectId).toBeNull();const enabled=await f.service.call('schedules.toggle',{id:schedule.id,expectedVersion:schedule.version,enabled:true});await f.service.call('sources.save',{id:src.id,expectedVersion:src.version,name:'修改源',baseUrl:src.baseUrl,models:src.models});const after=(await f.service.call('state.get',{})).schedules[0];expect(after.enabled).toBe(false);await expect(f.service.call('schedules.run',{id:schedule.id,triggerId:randomUUID()})).rejects.toThrow('版本');
 });
 it('records every missed daily UTC slot without replaying, and deduplicates recovery ticks',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const s=await f.service.call('schedules.save',{name:'错过验证',prompt:'不应自动执行',projectId:null,model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext(),spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});await f.store.transaction(()=>f.store.put('schedules',{...s,enabled:true,status:'active',nextRunAt:'2026-10-10T01:00:00.000Z',nextSlot:'2026-10-10T09:00[Asia/Shanghai]'}));await f.service.tick(true,'2026-10-12T02:00:00.000Z');await f.service.tick(true,'2026-10-12T02:00:00.000Z');const runs=await f.service.call('schedules.runs',{id:s.id});expect(runs).toHaveLength(3);expect(runs.every(r=>r.status==='missed'&&r.scheduledFor?.endsWith('Z'))).toBe(true);expect(m.requests).toHaveLength(0);expect((await f.service.call('state.get',{})).schedules[0].nextRunAt).toBe('2026-10-13T01:00:00.000Z');});
 it('allows only one concurrent retry and keeps the original user message once',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});const sent=await f.service.call('chat.send',{conversationId:c.id,text:'失败一次',model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext()});await event(f.service,sent.requestId,'chatFailed');const results=await Promise.allSettled([f.service.call('chat.retry',{conversationId:c.id,userMessageId:sent.userMessageId}),f.service.call('chat.retry',{conversationId:c.id,userMessageId:sent.userMessageId})]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);const retry=(results[0] as PromiseFulfilledResult<{requestId:string}>).value;await event(f.service,retry.requestId);expect(m.requests).toHaveLength(2);expect((await f.service.call('conversations.history',{id:c.id})).filter(m=>m.role==='user')).toHaveLength(1);expect(f.store.list('requests')).toHaveLength(2);});
 it('rejects stale source capture while a source address and credential edit is committing',async()=>{let hold=false,release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const f=await fixture(async(file,bytes)=>{if(hold){entered();await gate;}await atomicWrite(file,bytes);});const m1=await mock(),m2=await mock();const src=await source(f.service,m1.url,'old-test-key');const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});hold=true;const edit=f.service.call('sources.save',{id:src.id,expectedVersion:src.version,name:src.name,baseUrl:m2.url,models:src.models,secret:'new-test-key'});await reached;const send=f.service.call('chat.send',{conversationId:c.id,text:'receiver race',model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext()});const rejected=expect(send).rejects.toThrow('源配置');hold=false;release();const updated=await edit;await rejected;expect(m1.requests).toHaveLength(0);expect(m2.requests).toHaveLength(0);expect(f.store.list('messages')).toHaveLength(0);const sent=await f.service.call('chat.send',{conversationId:c.id,text:'correct receiver',model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext()});await event(f.service,sent.requestId);expect(m2.requests[0].authorization).toBe('Bearer new-test-key');const assistant=(await f.service.call('conversations.history',{id:c.id})).find(m=>m.role==='assistant')!;expect((assistant.snapshot as any).sourceVersion).toBe(updated.configVersion);expect((await fs.readFile(f.store.file)).includes(Buffer.from('new-test-key'))).toBe(false);});
 it('checkpoints received partial text before completion and recovers it as interrupted',async()=>{const f=await fixture();const m=await mock();const src=await source(f.service,m.url);const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});const sent=await f.service.call('chat.send',{conversationId:c.id,text:'慢回复验证持久化',model:{sourceId:src.id,modelId:'workday-mock'},context:emptyContext()});await vi.waitFor(()=>{const partial=f.store.list<any>('messages').find(m=>m.role==='assistant');expect(partial.status).toBe('running');expect(partial.content.length).toBeGreaterThan(1);},{timeout:3000});const file=path.join(f.dir,'crash-copy.sqlite');await fs.copyFile(f.store.file,file);const copy=await Store.open(file);const recovered=new AppService(copy,f.credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>null,openBackup:async()=>null,openExternal:async()=>{},openDirectory:async()=>{}},f.dir);await recovered.recover();expect(copy.list<any>('messages').find(m=>m.role==='assistant')).toMatchObject({status:'failed'});expect(copy.list<any>('messages').find(m=>m.role==='assistant').content.length).toBeGreaterThan(1);await recovered.dispose();copy.close();const stopped=event(f.service,sent.requestId,'chatCancelled');await f.service.call('chat.cancel',{requestId:sent.requestId});await stopped;});
 it('shares concurrent MCP connection and rechecks a revoked grant after awaiting connection',async()=>{const f=await fixture();const http=await httpMcp('awaited-read');let m=await f.service.call('mcp.save',{name:'连接竞态',transport:'http',url:http.url,command:'',args:[]});m=await f.service.call('mcp.toggle',{id:m.id,expectedVersion:m.version,enabled:true});m=await f.service.call('mcp.discover',{id:m.id});await f.service.mcp.close(m.id);const [one,two]=await Promise.all([f.service.mcp.connect(m),f.service.mcp.connect(m)]);expect(one).toBe(two);const c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});const grant=await f.service.call('grants.save',{scopeType:'conversation',scopeId:c.id,mcpId:m.id,configVersion:m.configVersion,capabilityType:'tool',capabilityName:'lookup',readOnly:true,allowedSchema:{type:'object',properties:{topic:{const:'WorkDay'}},required:['topic'],additionalProperties:false}});let release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const original=f.service.mcp.connect.bind(f.service.mcp);const spy=vi.spyOn(f.service.mcp,'connect').mockImplementation(async server=>{const client=await original(server);entered();await gate;return client;});const call=f.service.call('mcp.call',{id:m.id,scopeType:'conversation',scopeId:c.id,name:'lookup',arguments:{topic:'WorkDay'}});const denied=expect(call).rejects.toThrow('授权');await reached;await f.service.call('grants.revoke',{id:grant.id,expectedVersion:grant.version});release();await denied;spy.mockRestore();expect(http.calls).toBe(0);});

});

it('queries public holidays through IPC, opens only verified cached source, and leaves business backup rows unchanged',async()=>{
 const f=await fixture();const before=await f.service.backup();const url='https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm';const html=await fs.readFile('tests/fixtures/holidays-2026.html','utf8');
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>input.includes('search-gov')?new Response(JSON.stringify({code:200,msg:'成功',data:[],searchVO:{listVO:[{title:'国务院办公厅关于2026年部分节假日安排的通知',puborg:'国务院办公厅',url}]}}),{headers:{'Content-Type':'application/json'}}):new Response(html,{headers:{'Content-Type':'text/html'}})));
 expect((await f.service.call('holidays.query',{year:2026})).status).toBe('updated');expect(await f.service.call('holidays.openSource',{year:2026})).toBe(true);expect(f.opened).toEqual([url]);expect((await f.service.backup()).rows).toEqual(before.rows);
 await expect(f.service.call('holidays.openSource',{year:2027})).rejects.toThrow('暂无');await expect(f.service.call('holidays.query',{year:2026,url:'https://evil.test'})).rejects.toThrow('参数');
 const file=path.join(f.dir,'holidays/2026.json');const data=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...data,sourceUrl:'https://evil.test/notice'}));await expect(f.service.call('holidays.openSource',{year:2026})).rejects.toThrow('暂无');expect(f.opened).toEqual([url]);
});

it('weather IPC returns public date data without changing business rows, credentials or event state',async()=>{
 const f=await fixture();await source(f.service,'https://model.example/v1','private-weather-test-key');
 const before=await f.service.backup(),credentials=await fs.readFile(path.join(f.dir,'credentials.json'));const events:AppEvent[]=[];f.service.subscribe(event=>events.push(event));
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
 const location={name:'杭州',country:'中国',region:'浙江省',latitude:30.29,longitude:120.16,timezone:'Asia/Shanghai'};
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string,init:RequestInit)=>{calls.push(input);expect(init.credentials).toBe('omit');expect(new Headers(init.headers).get('authorization')).toBeNull();return new Response(JSON.stringify(input.includes('geocoding-')?{results:[{name:'杭州',country:'中国',admin1:'浙江省',latitude:30.29,longitude:120.16,timezone:'Asia/Shanghai'}]}:{daily_units:{time:'iso8601',weather_code:'wmo code',temperature_2m_min:'°C',temperature_2m_max:'°C'},daily:{time:[today],weather_code:[0],temperature_2m_min:[0],temperature_2m_max:[9]}}),{headers:{'Content-Type':'application/json'}});}));
 expect(await f.service.call('weather.search',{query:'杭州'})).toEqual([location]);
 expect(await f.service.call('weather.query',{date:today,location})).toMatchObject({status:'ready',location,day:{date:today,code:0,temperatureMin:0,temperatureMax:9}});
 await expect(f.service.call('weather.query',{date:today,location,url:'https://evil.test'})).rejects.toThrow('参数');
 expect(calls).toHaveLength(2);expect(calls.every(url=>!url.includes('private-weather-test-key'))).toBe(true);
 expect((await f.service.backup()).rows).toEqual(before.rows);expect(await fs.readFile(path.join(f.dir,'credentials.json'))).toEqual(credentials);expect(events).toEqual([]);
});

describe('folder projects and archived conversations',()=>{
 it('selects folders without writes, validates and canonicalizes saves, and permits offline rename',async()=>{
  const f=await fixture(),fields={name:'自定义名称',description:'简介'};
  expect(await f.service.call('projects.pickDirectory',{})).toBeNull();expect(f.store.list('projects')).toEqual([]);
  const folder=path.join(f.dir,'项目文件夹');await fs.mkdir(folder);f.setProject(folder);
  expect(await f.service.call('projects.pickDirectory',{})).toEqual({directory:await fs.realpath(folder),name:'项目文件夹'});expect(f.store.list('projects')).toEqual([]);
  const file=path.join(f.dir,'file.txt');await fs.writeFile(file,'do not read me');
  for(const directory of [null,'relative/path',file,path.join(f.dir,'missing'),'/bad\0path','/'+ 'x'.repeat(4096)])await expect(f.service.call('projects.save',{...fields,directory})).rejects.toThrow();
  f.setProject(file);await expect(f.service.call('projects.pickDirectory',{})).rejects.toThrow('文件夹');
  const p=await f.service.call('projects.save',{...fields,directory:folder});expect(p).toMatchObject({...fields,directory:await fs.realpath(folder),archived:false});
  const alias=path.join(f.dir,'alias');await fs.symlink(folder,alias);await expect(f.service.call('projects.save',{...fields,directory:alias})).rejects.toThrow('已关联');
  const archived=await f.service.call('projects.archive',{id:p.id,expectedVersion:p.version,archived:true});await expect(f.service.call('projects.save',{...fields,directory:folder})).rejects.toThrow('已关联');
  await fs.rmdir(folder);const renamed=await f.service.call('projects.save',{...fields,id:p.id,expectedVersion:archived.version,directory:p.directory,name:'离线改名'});expect(renamed.name).toBe('离线改名');
  await expect(f.service.call('projects.save',{...fields,id:p.id,expectedVersion:renamed.version,directory:null})).rejects.toThrow('不能清空');
  const other=path.join(f.dir,'other');await fs.mkdir(other);const results=await Promise.allSettled([f.service.call('projects.save',{...fields,directory:other}),f.service.call('projects.save',{...fields,directory:other})]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
 });
 it('fills legacy fields without changing history or versions and lets a folderless project be named then bound',async()=>{
  const f=await fixture();const p={id:randomUUID(),version:7,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2021-01-01T00:00:00.000Z',name:'旧项目',description:'旧简介',archived:true};
  const c={...p,id:randomUUID(),title:'旧聊天',projectId:p.id,model:null,context:emptyContext(),activeRequestId:null} as any;delete c.name;delete c.description;delete c.archived;
  await f.store.transaction(()=>{f.store.put('projects',p);f.store.put('conversations',c);});await f.service.recover();
  expect(f.store.get('projects',p.id)).toEqual({...p,directory:null,repository:null});expect(f.store.get('conversations',c.id)).toEqual({...c,archived:false});
  const copy=await Store.open(f.store.file);expect(copy.get('conversations',c.id)).toEqual({...c,archived:false});copy.close();
  const renamed=await f.service.call('projects.save',{id:p.id,expectedVersion:p.version,name:'旧项目改名',description:p.description,directory:null});expect(renamed.directory).toBeNull();
  const bound=await f.service.call('projects.save',{id:p.id,expectedVersion:renamed.version,name:renamed.name,description:renamed.description,directory:f.dir});expect(bound.directory).toBe(await fs.realpath(f.dir));expect(bound.archived).toBe(true);
 });
 it('archives and restores history and drafts, rejecting edits and active generation',async()=>{
  const f=await fixture(),m=await mock(),src=await source(f.service,m.url),model={sourceId:src.id,modelId:'workday-mock'};
  const p=await f.service.call('projects.save',{name:'归档项目',description:'',directory:f.dir});const c=await f.service.call('conversations.create',{projectId:p.id,date:'2026-10-13',model});
  const running=await f.service.call('chat.send',{conversationId:c.id,text:'慢回复',model,context:emptyContext()});const active=f.store.get<any>('conversations',c.id);
  await expect(f.service.call('conversations.archive',{id:c.id,expectedVersion:active.version,archived:true})).rejects.toThrow('生成中');
  const stopped=event(f.service,running.requestId,'chatCancelled');await f.service.call('chat.cancel',{requestId:running.requestId});await stopped;
  const draftSent=await f.service.call('chat.send',{conversationId:c.id,text:'草案',model,context:{...emptyContext(),date:'2026-10-13'}});await event(f.service,draftSent.requestId);
  const before=f.store.get<any>('conversations',c.id),history=await f.service.call('conversations.history',{id:c.id}),draft=f.store.list<any>('drafts')[0];expect(draft).toBeDefined();
  const archived=await f.service.call('conversations.archive',{id:c.id,expectedVersion:before.version,archived:true});expect(archived).toMatchObject({id:c.id,projectId:p.id,context:before.context,model,archived:true,version:before.version+1});
  await expect(f.service.call('conversations.archive',{id:c.id,expectedVersion:before.version,archived:false})).rejects.toThrow('修改');
  const edit={id:c.id,expectedVersion:archived.version};
  for(const [op,payload] of [
   ['conversations.rename',{...edit,title:'拒绝'}],['conversations.move',{...edit,projectId:null}],['conversations.context',{...edit,context:emptyContext()}],
   ['chat.send',{conversationId:c.id,text:'拒绝',model,context:emptyContext()}],['chat.retry',{conversationId:c.id,userMessageId:running.userMessageId}],
   ['drafts.save',{id:draft.id,expectedVersion:draft.version,actions:draft.actions}],['drafts.apply',{id:draft.id,expectedVersion:draft.version}],['drafts.discard',{id:draft.id,expectedVersion:draft.version}]
  ] as const)await expect(f.service.call(op,payload)).rejects.toThrow('归档');
  expect(await f.service.call('conversations.history',{id:c.id})).toEqual(history);expect(f.store.get('drafts',draft.id)).toEqual(draft);expect(f.store.list('tasks')).toEqual([]);
  const restored=await f.service.call('conversations.archive',{...edit,archived:false});expect(restored).toMatchObject({id:c.id,projectId:p.id,archived:false,context:before.context});expect(await f.service.call('conversations.history',{id:c.id})).toEqual(history);
  await f.service.call('drafts.apply',{id:draft.id,expectedVersion:draft.version});expect(f.store.list('tasks')).toHaveLength(1);
 });
 it('rechecks archive inside send and retry transactions without adding requests or messages',async()=>{
  const f=await fixture(),m=await mock(),src=await source(f.service,m.url),model={sourceId:src.id,modelId:'workday-mock'};
  const c=await f.service.call('conversations.create',{projectId:null,date:null,model});
  const failed=await f.service.call('chat.send',{conversationId:c.id,text:'失败一次',model,context:emptyContext()});await event(f.service,failed.requestId,'chatFailed');
  for(const operation of ['chat.send','chat.retry'] as const){
   const before=f.store.get<any>('conversations',c.id),history=await f.service.call('conversations.history',{id:c.id}),requests=f.store.list('requests'),count=m.requests.length;
   let release!:()=>void;const gate=new Promise<void>(r=>release=r);const blocked=f.store.transaction(()=>gate);
   const archived=f.service.call('conversations.archive',{id:c.id,expectedVersion:before.version,archived:true});
   const sending=f.service.call(operation,operation==='chat.send'?{conversationId:c.id,text:'竞态不应发送',model,context:emptyContext()}:{conversationId:c.id,userMessageId:failed.userMessageId});
   const denied=expect(sending).rejects.toThrow('归档');release();await blocked;const result=await archived;await denied;
   expect(m.requests.length).toBe(count);expect(f.store.list('requests')).toEqual(requests);expect(await f.service.call('conversations.history',{id:c.id})).toEqual(history);
   await f.service.call('conversations.archive',{id:c.id,expectedVersion:result.version,archived:false});
  }
 });
 it('restores legacy defaults and new folder/archive fields after raw checksum validation without requiring folders to exist',async()=>{
  const f=await fixture(),p=await f.service.call('projects.save',{name:'备份项目',description:'',directory:f.dir});const c=await f.service.call('conversations.create',{projectId:p.id,date:null,model:null});await f.service.call('conversations.archive',{id:c.id,expectedVersion:c.version,archived:true});
  const original=await f.service.backup(),file=path.join(f.dir,'backup.json');f.setBackup(file);
  const rehash=(backup:any)=>backup.sha256=createHash('sha256').update(JSON.stringify({format:backup.format,version:backup.version,rows:backup.rows,packages:backup.packages,...(backup.version===2?{skillFiles:backup.skillFiles}:{})})).digest('hex');
  for(const legacy of [false,true]){
   const backup=structuredClone(original);if(legacy){delete backup.rows.projects[0].directory;delete backup.rows.conversations[0].archived;}else backup.rows.projects[0].directory='/unavailable-other-computer/workspace';rehash(backup);
   await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{});const result=await f.service.call('data.restoreCopy',{token:preview!.token});const copy=await Store.open(path.join(result.path,'workday.sqlite'));
   expect(copy.get<any>('projects',p.id).directory).toBe(legacy?null:'/unavailable-other-computer/workspace');expect(copy.get<any>('conversations',c.id)).toMatchObject({projectId:p.id,archived:!legacy,version:2});copy.close();
  }
  const corrupt=structuredClone(original);corrupt.rows.projects[0].name='tampered';await fs.writeFile(file,JSON.stringify(corrupt));await expect(f.service.call('data.validate',{})).rejects.toThrow('校验和');
  for(const directory of ['relative/path','/bad\0path']){const invalid=structuredClone(original);invalid.rows.projects[0].directory=directory;rehash(invalid);await fs.writeFile(file,JSON.stringify(invalid));await expect(f.service.call('data.validate',{})).rejects.toThrow('参数无效');}
  expect(f.store.get<any>('projects',p.id).directory).toBe(p.directory);expect(f.store.get<any>('conversations',c.id).archived).toBe(true);
 });
});


describe('task due dates',()=>{
 it('defaults, preserves and clears due dates across edits, conflicts, completion, delete/restore and reopening',async()=>{
  const f=await fixture(),s=f.service;
  const fields={title:'快速待办',notes:'',date:'2028-03-01',projectId:null,completed:false};
  let task=await s.call('tasks.save',fields);expect(task.dueDate).toBeNull();
  const original=task;
  task=await s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,dueDate:'2028-02-29'});
  expect(task).toMatchObject({date:'2028-03-01',dueDate:'2028-02-29'});
  await expect(s.call('tasks.save',{...fields,id:task.id,expectedVersion:original.version,dueDate:null})).rejects.toThrow('修改');
  for(const dueDate of ['2027-02-29','2028-02-30','2028-13-01','','2028-02-29T12:00:00Z'])
   await expect(s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,dueDate})).rejects.toThrow('参数无效');
  expect(f.store.get('tasks',task.id)).toEqual(task);
  task=await s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,title:'修改内容',completed:true});
  expect(task).toMatchObject({title:'修改内容',completed:true,dueDate:'2028-02-29'});
  const deleted=await s.call('tasks.delete',{id:task.id,expectedVersion:task.version});expect(deleted.dueDate).toBe('2028-02-29');
  task=await s.call('tasks.restore',{id:task.id,expectedVersion:deleted.version});expect(task).toMatchObject({deletedAt:null,dueDate:'2028-02-29'});
  const reopened=await Store.open(f.store.file);try{expect(reopened.get('tasks',task.id)).toEqual(task);}finally{reopened.close();}
  task=await s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,dueDate:null});expect(task.dueDate).toBeNull();
  task=await s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version});expect(task.dueDate).toBeNull();
  task=await s.call('tasks.save',{...fields,id:task.id,expectedVersion:task.version,dueDate:'2028-02-29'});expect(task.dueDate).toBe('2028-02-29');
 });
 it('fills only missing legacy due dates without changing versions or timestamps',async()=>{
  const f=await fixture();
  const legacy={id:randomUUID(),version:7,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2021-01-01T00:00:00.000Z',priority:'P2',title:'旧待办',notes:'原备注',date:'2026-10-13',projectId:null,completed:true,deletedAt:null};
  const withDue={...legacy,id:randomUUID(),dueDate:'2026-10-12'},withoutDue={...legacy,id:randomUUID(),dueDate:null};
  await f.store.transaction(()=>{for(const task of [legacy,withDue,withoutDue])f.store.put('tasks',task);});
  await f.service.recover();await f.service.recover();
  expect((await f.service.call('state.get',{})).tasks).toEqual([{...legacy,dueDate:null},withDue,withoutDue].map(task=>({...task,completedDate:task.date})));
  const reopened=await Store.open(f.store.file);try{expect(reopened.list('tasks')).toEqual([{...legacy,dueDate:null},withDue,withoutDue].map(task=>({...task,completedDate:task.date})));}finally{reopened.close();}
 });
 it('gives AI-created tasks no deadline and preserves deadlines through existing draft actions',async()=>{
  const f=await fixture(),m=await mock(),src=await source(f.service,m.url);
  const c=await f.service.call('conversations.create',{projectId:null,date:'2026-10-13',model:null});
  const sent=await f.service.call('chat.send',{conversationId:c.id,text:'给我一个草案',model:{sourceId:src.id,modelId:'workday-mock'},context:{...emptyContext(),date:'2026-10-13'}});
  await event(f.service,sent.requestId);const draft=(await f.service.call('state.get',{})).drafts[0];
  await f.service.call('drafts.apply',{id:draft.id,expectedVersion:draft.version});
  let task=(await f.service.call('state.get',{})).tasks[0];expect(task.dueDate).toBeNull();
  task=await f.service.call('tasks.save',{id:task.id,expectedVersion:task.version,title:task.title,notes:task.notes,date:task.date,projectId:task.projectId,completed:task.completed,dueDate:'2026-10-20'});
  for(const change of [{type:'update',title:'草案修改',notes:'草案备注'},{type:'complete',completed:true},{type:'reschedule',date:'2026-10-25'}] as const){
   const action={...change,taskId:task.id,expectedVersion:task.version};
   const pending={...draft,id:randomUUID(),version:1,status:'pending' as const,taskIds:[task.id],actions:[action],appliedTaskIds:[]};
   await f.store.transaction(()=>f.store.put('drafts',pending));
   await f.service.call('drafts.apply',{id:pending.id,expectedVersion:pending.version});
   task=(await f.service.call('state.get',{})).tasks[0];expect(task.dueDate).toBe('2026-10-20');
  }
  expect(task).toMatchObject({title:'草案修改',notes:'草案备注',completed:true,date:'2026-10-25',dueDate:'2026-10-20'});
 });
 it('restores new and legacy deadline backups and rejects invalid dates even with a matching checksum',async()=>{
  const f=await fixture();
  const task=await f.service.call('tasks.save',{title:'截止日期备份',notes:'',date:'2028-03-01',projectId:null,completed:false,dueDate:'2028-02-29'});
  const original=await f.service.backup(),file=path.join(f.dir,'due-date-backup.json');f.setBackup(file);
  const rehash=(backup:any)=>backup.sha256=createHash('sha256').update(JSON.stringify({format:backup.format,version:backup.version,rows:backup.rows,packages:backup.packages,...(backup.version===2?{skillFiles:backup.skillFiles}:{})})).digest('hex');
  for(const legacy of [false,true]){
   const backup=structuredClone(original);if(legacy){delete backup.rows.tasks[0].dueDate;rehash(backup);}
   await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{});const restored=await f.service.call('data.restoreCopy',{token:preview!.token});
   const copy=await Store.open(path.join(restored.path,'workday.sqlite'));
   try{expect(copy.get('tasks',task.id)).toEqual({...task,dueDate:legacy?null:task.dueDate});}finally{copy.close();}
  }
  const corrupt=structuredClone(original);corrupt.rows.tasks[0].dueDate='2028-03-10';await fs.writeFile(file,JSON.stringify(corrupt));await expect(f.service.call('data.validate',{})).rejects.toThrow('校验和');
  for(const dueDate of ['2027-02-29','','2028-02-29T12:00:00Z',42]){
   const invalid=structuredClone(original);invalid.rows.tasks[0].dueDate=dueDate;rehash(invalid);await fs.writeFile(file,JSON.stringify(invalid));
   await expect(f.service.call('data.validate',{})).rejects.toThrow('参数无效');
  }
  expect(f.store.get('tasks',task.id)).toEqual(task);
 });
});

describe('unfinished task rollover',()=>{
 function clock(time='2027-01-01T00:00:00+08:00',zone='Asia/Shanghai'){
  const previousZone=Settings.defaultZone;Settings.defaultZone=zone;
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(time));
  cleanup.push(async()=>{Settings.defaultZone=previousZone;vi.useRealTimers();});
 }
 const storedTask=(changes:Partial<Task>={}):Task=>({id:randomUUID(),version:4,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-12-01T00:00:00.000Z',priority:'P2',title:'保留标题',notes:'保留备注',date:'2026-12-31',dueDate:'2026-12-25',projectId:null,completed:false,completedDate:null,deletedAt:null,...changes});
 it('moves only overdue unfinished tasks, retains every other field and persists one idempotent update',async()=>{
  clock();const persist=vi.fn(atomicWrite),f=await fixture(persist),project=await f.service.call('projects.save',{name:'顺延项目',description:'',directory:f.dir});
  const overdue=storedTask({projectId:project.id}),older=storedTask({date:'2026-12-20'});
  const unchanged=[storedTask({completed:true}),storedTask({deletedAt:'2026-12-31T08:00:00.000Z'}),storedTask({date:'2027-01-01'}),storedTask({date:'2027-01-02'})];
  await f.store.transaction(()=>{for(const task of [overdue,older,...unchanged])f.store.put('tasks',task);});
  const events=vi.fn();f.service.subscribe(events);persist.mockClear();await f.service.tick();
  const expected=[overdue,older].map(task=>({...task,date:'2027-01-01',version:task.version+1,updatedAt:new Date().toISOString()}));
  expect(f.store.list('tasks')).toEqual([...expected,...unchanged]);expect(persist).toHaveBeenCalledTimes(1);expect(events).toHaveBeenCalledExactlyOnceWith({type:'stateChanged'});
  const reopened=await Store.open(f.store.file);try{expect(reopened.list('tasks')).toEqual([...expected,...unchanged]);}finally{reopened.close();}
  await f.service.tick();await f.service.tick(true);await f.service.tick(false,'2026-12-30T00:00:00+08:00');
  expect(f.store.list('tasks')).toEqual([...expected,...unchanged]);expect(persist).toHaveBeenCalledTimes(1);expect(events).toHaveBeenCalledTimes(1);
 });
 it.each([
  ['Asia/Shanghai','2026-12-31T15:59:59.999Z','2026-12-31T16:00:00.000Z','2026-12-31','2027-01-01'],
  ['America/Los_Angeles','2026-11-01T06:59:59.999Z','2026-11-01T07:00:00.000Z','2026-10-31','2026-11-01'],
  ['America/Los_Angeles','2027-03-15T06:59:59.999Z','2027-03-15T07:00:00.000Z','2027-03-14','2027-03-15']
 ])('uses local midnight across %s boundaries (%s)',async(zone,before,after,oldDate,newDate)=>{
  clock(before,zone);const f=await fixture(),task=storedTask({date:oldDate});await f.store.transaction(()=>f.store.put('tasks',task));
  await f.service.tick();expect(f.store.get('tasks',task.id)).toEqual(task);
  vi.setSystemTime(new Date(after));await f.service.tick();expect(f.store.get('tasks',task.id)).toEqual({...task,date:newDate,version:task.version+1,updatedAt:after});
 });
 it('catches up after multiple closed days on recover and after resume without duplicating history',async()=>{
  clock();const f=await fixture(),pending=storedTask({date:'2026-12-20'}),complete=storedTask({date:'2026-12-20',completed:true});
  await f.store.transaction(()=>{f.store.put('tasks',pending);f.store.put('tasks',complete);});
  await f.service.recover();expect(f.store.get<Task>('tasks',pending.id)).toMatchObject({date:'2027-01-01',version:5});expect(f.store.get('tasks',complete.id)).toEqual(complete);
  vi.setSystemTime(new Date('2027-01-04T08:00:00+08:00'));await f.service.tick(true);await f.service.tick(true);
  expect(f.store.list('tasks')).toHaveLength(2);expect(f.store.get<Task>('tasks',pending.id)).toMatchObject({date:'2027-01-04',version:6});expect(f.store.get('tasks',complete.id)).toEqual(complete);
  await f.service.recover();expect(f.store.get<Task>('tasks',pending.id)?.version).toBe(6);
 });
 it('keeps failed persistence invisible and retries without changing identity or losing content',async()=>{
  clock();let fail=false;const f=await fixture(async(file,data)=>{if(fail)throw new Error('simulated rollover disk failure');await atomicWrite(file,data);});
  const task=storedTask();await f.store.transaction(()=>f.store.put('tasks',task));const before=await fs.readFile(f.store.file),events=vi.fn();f.service.subscribe(events);
  fail=true;await expect(f.service.tick()).rejects.toThrow('simulated rollover disk failure');
  expect(f.store.get('tasks',task.id)).toEqual(task);expect(await fs.readFile(f.store.file)).toEqual(before);expect(events).not.toHaveBeenCalled();
  fail=false;await f.service.tick();expect(f.store.get('tasks',task.id)).toEqual({...task,date:'2027-01-01',version:5,updatedAt:new Date().toISOString()});expect(events).toHaveBeenCalledExactlyOnceWith({type:'stateChanged'});
 });
 it('rechecks queued completion and deletion instead of writing the prescreen snapshot back',async()=>{
  clock();const f=await fixture(),complete=storedTask(),deleted=storedTask(),pending=storedTask();
  await f.store.transaction(()=>{for(const task of [complete,deleted,pending])f.store.put('tasks',task);});
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),blocked=f.store.transaction(()=>gate);
  const completing=f.service.call('tasks.save',{id:complete.id,expectedVersion:complete.version,title:complete.title,notes:'新备注',date:complete.date,projectId:null,completed:true});
  const deleting=f.service.call('tasks.delete',{id:deleted.id,expectedVersion:deleted.version});
  const rollover=f.service.tick();release();await blocked;const completed=await completing,removed=await deleting;await rollover;
  expect(f.store.get('tasks',complete.id)).toEqual(completed);expect(completed).toMatchObject({date:'2026-12-31',completed:true,notes:'新备注',version:5});
  expect(f.store.get('tasks',deleted.id)).toEqual(removed);expect(removed.date).toBe('2026-12-31');expect(removed.deletedAt).not.toBeNull();
  expect(f.store.get('tasks',pending.id)).toMatchObject({date:'2027-01-01',version:5});
  await expect(f.service.call('tasks.save',{id:pending.id,expectedVersion:pending.version,title:'过期编辑',notes:'',date:pending.date,projectId:null,completed:false})).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.store.get('tasks',pending.id)).toMatchObject({title:pending.title,date:'2027-01-01',version:5});
 });
 it('normalizes save and restore in their existing transaction while retaining completed history',async()=>{
  clock();const f=await fixture(),fields={title:'新待办',notes:'备注',date:'2026-12-20',dueDate:'2026-12-21',projectId:null,completed:false};
  const fresh=await f.service.call('tasks.save',fields);expect(fresh).toMatchObject({...fields,date:'2027-01-01',version:1});
  const moved=await f.service.call('tasks.save',{...fields,id:fresh.id,expectedVersion:fresh.version,date:'2026-12-19'});expect(moved).toMatchObject({date:'2027-01-01',version:2,dueDate:fields.dueDate});
  const completed=await f.service.call('tasks.save',{...fields,completed:true});expect(completed).toMatchObject({date:fields.date,completed:true});
  const reopened=await f.service.call('tasks.save',{...fields,id:completed.id,expectedVersion:completed.version});expect(reopened).toMatchObject({date:'2027-01-01',completed:false,version:2});
  for(const completed of [false,true]){
   const task=storedTask({completed,deletedAt:'2026-12-30T00:00:00.000Z'});await f.store.transaction(()=>f.store.put('tasks',task));
   const restored=await f.service.call('tasks.restore',{id:task.id,expectedVersion:task.version});
   expect(restored).toEqual({...task,deletedAt:null,date:completed?task.date:'2027-01-01',version:5,updatedAt:new Date().toISOString()});
  }
 });
 it('normalizes every AI task action and still rejects stale task versions atomically',async()=>{
  clock();const f=await fixture(),c=await f.service.call('conversations.create',{projectId:null,date:null,model:null});
  const apply=async(actions:TaskAction[],taskIds:string[]=[])=>{
   const draft:Draft={id:randomUUID(),version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),conversationId:c.id,messageId:randomUUID(),projectId:null,taskIds,actions,status:'pending',appliedTaskIds:[]};
   await f.store.transaction(()=>f.store.put('drafts',draft));return f.service.call('drafts.apply',{id:draft.id,expectedVersion:1});
  };
  const created=await apply([{type:'create',title:'草案创建',notes:'保留',date:'2026-12-01',projectId:null}]);if((created.kind==='file'||created.kind==='component'))throw Error('Expected task draft');
  expect(f.store.get('tasks',created.appliedTaskIds[0])).toMatchObject({date:'2027-01-01',version:1,title:'草案创建',notes:'保留'});
  for(const action of [{type:'update',title:'新标题',notes:'新备注'},{type:'reschedule',date:'2026-12-15'},{type:'complete',completed:false},{type:'complete',completed:true}] as const){
   const task=storedTask({completed:action.type==='complete'&&!action.completed});await f.store.transaction(()=>f.store.put('tasks',task));
   await apply([{...action,taskId:task.id,expectedVersion:task.version}],[task.id]);
   expect(f.store.get('tasks',task.id)).toMatchObject({id:task.id,date:action.type==='complete'&&action.completed?task.date:'2027-01-01',version:5,dueDate:task.dueDate,createdAt:task.createdAt});
  }
  const task=storedTask();await f.store.transaction(()=>f.store.put('tasks',task));await f.service.tick();const before=f.store.list('tasks');
  await expect(apply([{type:'create',title:'不能部分保存',date:'2026-12-20',projectId:null},{type:'complete',taskId:task.id,expectedVersion:task.version,completed:true}],[task.id])).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.store.list('tasks')).toEqual(before);
 });
});

describe('automatic calendar task context',()=>{
 const date='2099-10-14';
 const selection=():ContextSelection=>({...emptyContext(),date,calendarTasks:true});
 const calendarData=(system:string)=>JSON.parse(system.match(/Calendar tasks for [^\n]+\n([^\n]+)/)![1]);
 const systemAt=(m:Awaited<ReturnType<typeof mock>>,index=-1)=>m.requests.at(index).body.messages.find((message:any)=>message.role==='system').content as string;
 async function setup(){const f=await fixture(),m=await mock(),src=await source(f.service,m.url),model={sourceId:src.id,modelId:'workday-mock'};return {...f,m,model};}
 async function task(f:Awaited<ReturnType<typeof fixture>>,title:string,changes:Partial<Task>&{expectedVersion?:number}={}){return f.service.call('tasks.save',{title,notes:title+' 备注',date,projectId:null,completed:false,...changes});}
 it('sends the whole selected day as fresh read-only data across projects, including completed records',async()=>{
  const f=await setup(),p1=await f.service.call('projects.save',{name:'项目一',description:'不得自动带入简介',directory:f.dir});
  const secondDir=path.join(f.dir,'second');await fs.mkdir(secondDir);const p2=await f.service.call('projects.save',{name:'项目二',description:'',directory:secondDir});
  let a=await task(f,'当天未完成',{projectId:p1.id});const b=await task(f,'当天已完成',{projectId:p2.id,completed:true,completedDate:date}),c=await task(f,'当天无项目');
  const deleted=await task(f,'已删除不得带入');await f.service.call('tasks.delete',{id:deleted.id,expectedVersion:deleted.version});await task(f,'其他日期不得带入',{date:'2099-10-15'});
  const conversation=await f.service.call('conversations.create',{projectId:p1.id,date,model:f.model});
  const send=async()=>{const sent=await f.service.call('chat.send',{conversationId:conversation.id,text:'看看当天',model:f.model,context:selection()});await event(f.service,sent.requestId);return sent;};
  const first=await send(),initial=systemAt(f.m),rows=calendarData(initial);
  expect(rows).toEqual([a,b,c].map(t=>({id:t.id,title:t.title,notes:t.notes,date:t.date,dueDate:t.dueDate,priority:t.priority,completed:t.completed,completedDate:t.completedDate,projectId:t.projectId,projectName:t.projectId===p1.id?p1.name:t.projectId===p2.id?p2.name:null})));
  expect(initial).toContain('read-only reference data');expect(initial).not.toContain('已删除不得带入');expect(initial).not.toContain('其他日期不得带入');expect(initial).not.toContain(f.dir);
  const frozen=f.store.get<any>('requests',first.requestId);expect(frozen.context.taskIds).toEqual([]);expect(frozen.snapshot).toBe(initial);
  a=await task(f,'新标题',{id:a.id,expectedVersion:a.version,projectId:a.projectId,notes:'新备注',completed:true,completedDate:date});await f.service.call('tasks.delete',{id:c.id,expectedVersion:c.version});const added=await task(f,'新加入');
  await send();const updated=calendarData(systemAt(f.m));expect(updated.map((t:any)=>t.id)).toEqual([a.id,b.id,added.id]);expect(updated[0]).toMatchObject({title:'新标题',notes:'新备注',completed:true,completedDate:date});expect(f.store.get<any>('requests',first.requestId).snapshot).toBe(initial);
  const empty=await f.service.call('chat.send',{conversationId:conversation.id,text:'空日期',model:f.model,context:{...selection(),date:'2099-10-16'}});await event(f.service,empty.requestId);expect(calendarData(systemAt(f.m))).toEqual([]);expect(systemAt(f.m)).toContain('There are no tasks on the selected date.');
 });
 it('keeps the failed request snapshot on retry, while a new send reads current task data',async()=>{
  const f=await setup();let t=await task(f,'重试前内容');const c=await f.service.call('conversations.create',{projectId:null,date,model:f.model});
  const failed=await f.service.call('chat.send',{conversationId:c.id,text:'日历失败一次',model:f.model,context:selection()});await event(f.service,failed.requestId,'chatFailed');const original=systemAt(f.m);
  t=await task(f,'重试后内容',{id:t.id,expectedVersion:t.version,completed:true,completedDate:date});
  const retry=await f.service.call('chat.retry',{conversationId:c.id,userMessageId:failed.userMessageId});await event(f.service,retry.requestId);expect(systemAt(f.m)).toBe(original);
  const next=await f.service.call('chat.send',{conversationId:c.id,text:'新请求',model:f.model,context:selection()});await event(f.service,next.requestId);expect(calendarData(systemAt(f.m))[0]).toMatchObject({title:t.title,completed:true});
 });
 it('does not add automatic calendar data to legacy conversations or schedules, and move clears the flag',async()=>{
  const f=await setup();await task(f,'不应隐式携带');const legacy={...emptyContext(),date},c=await f.service.call('conversations.create',{projectId:null,date,model:f.model});
  const sent=await f.service.call('chat.send',{conversationId:c.id,text:'旧对话',model:f.model,context:legacy});await event(f.service,sent.requestId);expect(systemAt(f.m)).not.toContain('不应隐式携带');expect(systemAt(f.m)).not.toContain('Calendar tasks');
  const schedule=await f.service.call('schedules.save',{name:'旧计划',prompt:'旧计划上下文',projectId:null,model:f.model,context:legacy,spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});await f.service.call('schedules.run',{id:schedule.id,triggerId:randomUUID()});await vi.waitFor(async()=>expect((await f.service.call('schedules.runs',{id:schedule.id}))[0].status).toBe('success'));
  expect(systemAt(f.m)).not.toContain('不应隐式携带');expect(systemAt(f.m)).not.toContain('Calendar tasks');
  const current=f.store.get<any>('conversations',c.id),bound=await f.service.call('conversations.context',{id:c.id,expectedVersion:current.version,context:selection()});
  const moved=await f.service.call('conversations.move',{id:c.id,expectedVersion:bound.version,projectId:null});expect(moved.context).toEqual(emptyContext());
 });
 it('does not grant modification rights to automatic tasks; explicit same-project task IDs still work',async()=>{
  const f=await fixture(),src=await source(f.service,'http://127.0.0.1:1/v1'),model={sourceId:src.id,modelId:'workday-mock'};
  const p=await f.service.call('projects.save',{name:'其他项目',description:'',directory:f.dir}),own=await task(f,'同项目只读'),other=await task(f,'跨项目只读',{projectId:p.id});
  const c=await f.service.call('conversations.create',{projectId:null,date,model});let target=own;
  vi.stubGlobal('fetch',vi.fn(async()=>{const content='```workday-actions\n'+JSON.stringify([{type:'complete',taskId:target.id,expectedVersion:target.version,completed:true}])+'\n```';return new Response('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}));
  for(target of [own,other]){const sent=await f.service.call('chat.send',{conversationId:c.id,text:'自动参考不能修改',model,context:selection()});await event(f.service,sent.requestId);expect(f.store.list('drafts')).toHaveLength(0);}
  await expect(f.service.call('chat.send',{conversationId:c.id,text:'伪造跨项目选择',model,context:{...selection(),taskIds:[other.id]}})).rejects.toThrow('项目范围');
  target=own;const sent=await f.service.call('chat.send',{conversationId:c.id,text:'显式选择',model,context:{...selection(),taskIds:[own.id]}});await event(f.service,sent.requestId);
  const draft=f.store.list<Draft>('drafts')[0];if((draft.kind==='file'||draft.kind==='component'))throw Error('Expected task draft');expect(draft.taskIds).toEqual([own.id]);await f.service.call('drafts.apply',{id:draft.id,expectedVersion:draft.version});expect(f.store.get<Task>('tasks',own.id)?.completed).toBe(true);expect(f.store.get<Task>('tasks',other.id)?.completed).toBe(false);
 });
 it('rejects invalid mode/date combinations and round-trips both old and new context backups',async()=>{
  const f=await setup(),c=await f.service.call('conversations.create',{projectId:null,date,model:f.model});
  for(const invalid of [{...selection(),date:null},{...selection(),date:'2099-02-30'},{...selection(),calendarTasks:'true'}])await expect(f.service.call('conversations.context',{id:c.id,expectedVersion:c.version,context:invalid})).rejects.toThrow('参数无效');
  await f.service.call('conversations.context',{id:c.id,expectedVersion:c.version,context:selection()});const original=await f.service.backup(),file=path.join(f.dir,'calendar-context.json');f.setBackup(file);
  const rehash=(backup:any)=>backup.sha256=createHash('sha256').update(JSON.stringify({format:backup.format,version:backup.version,rows:backup.rows,packages:backup.packages,...(backup.version===2?{skillFiles:backup.skillFiles}:{})})).digest('hex');
  for(const legacy of [false,true]){const backup=structuredClone(original);if(legacy)delete backup.rows.conversations[0].context.calendarTasks;rehash(backup);await fs.writeFile(file,JSON.stringify(backup));const preview=await f.service.call('data.validate',{}),restored=await f.service.call('data.restoreCopy',{token:preview!.token}),copy=await Store.open(path.join(restored.path,'workday.sqlite'));try{expect(copy.get<any>('conversations',c.id).context).toEqual(legacy?{...emptyContext(),date}:selection());}finally{copy.close();}}
  const invalid=structuredClone(original);invalid.rows.conversations[0].context.date=null;rehash(invalid);await fs.writeFile(file,JSON.stringify(invalid));await expect(f.service.call('data.validate',{})).rejects.toThrow('参数无效');
 });
 it('keeps all tasks beyond the manual selection limit and rejects oversized context atomically',async()=>{
  const f=await setup(),stamp=new Date().toISOString(),tasks:Task[]=Array.from({length:101},(_,i)=>({id:randomUUID(),version:1,createdAt:stamp,updatedAt:stamp,priority:'P2',title:'日历任务 '+i,notes:'',date,dueDate:null,projectId:null,completed:false,completedDate:null,deletedAt:null}));
  await f.store.transaction(()=>{for(const t of tasks)f.store.put('tasks',t);});const c=await f.service.call('conversations.create',{projectId:null,date,model:f.model});
  const sent=await f.service.call('chat.send',{conversationId:c.id,text:'全部任务',model:f.model,context:selection()});await event(f.service,sent.requestId);expect(calendarData(systemAt(f.m))).toHaveLength(101);
  await f.store.transaction(()=>{for(const t of tasks)f.store.put('tasks',{...t,notes:'X'.repeat(1000)});});const before={requests:f.store.list('requests'),history:await f.service.call('conversations.history',{id:c.id}),conversation:f.store.get('conversations',c.id),calls:f.m.requests.length};
  await expect(f.service.call('chat.send',{conversationId:c.id,text:'超长不得截断',model:f.model,context:selection()})).rejects.toMatchObject({code:'LIMIT'});
  expect(f.store.list('requests')).toEqual(before.requests);expect(await f.service.call('conversations.history',{id:c.id})).toEqual(before.history);expect(f.store.get('conversations',c.id)).toEqual(before.conversation);expect(f.m.requests).toHaveLength(before.calls);
 });
});
