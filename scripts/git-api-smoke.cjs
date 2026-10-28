const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),data=await fs.mkdtemp(path.join(os.tmpdir(),'workday-git-api-')),output=path.join(root,'output/playwright',process.env.WORKDAY_ELECTRON_EXECUTABLE?'git-api-stage':'git-api-source');
 await fs.mkdir(output,{recursive:true});let app;
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:process.env.WORKDAY_ELECTRON_EXECUTABLE?[]:[root],env,timeout:30000},{mockHolidays:true});
  const page=await app.firstWindow();
  await app.evaluate(({app,net,safeStorage,BrowserWindow})=>{
   const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),{AppService}=load('./dist/main/service.js'),originalCall=AppService.prototype.call;AppService.prototype.call=function(op,p){globalThis.__legacyGitService=this;return originalCall.call(this,op,p);};
   const window=BrowserWindow.getAllWindows()[0];window.hide();window.webContents.setBackgroundThrottling(false);
   safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=text=>Buffer.from('fixture:'+text);safeStorage.decryptString=bytes=>bytes.toString().slice(8);
   const original=net.fetch.bind(net);globalThis.__gitAPI={requests:[],systems:[],failNext:false};
   const repo={id:22,owner:{login:'fixture-owner'},name:'fixture-repo',default_branch:'main',private:true,description:'Synthetic repository',temp_clone_token:'EXCLUDED_SYNTHETIC_REMOTE_TOKEN'};
   net.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url??input.href),fixture=globalThis.__gitAPI;
    if(url.hostname==='api.github.com'){
     if(init.method!=='GET'||init.redirect!=='error'||init.credentials!=='omit'||init.headers.Authorization!=='Bearer SYNTHETIC_GIT_PAT')throw Error('Git API request boundary failed');
     fixture.requests.push({path:url.pathname,query:url.search});
     if(url.pathname==='/user')return Response.json({id:11,login:'fixture-user',secret:'EXCLUDED_SYNTHETIC_REMOTE_TOKEN'});
     if(url.pathname==='/user/repos')return Response.json(url.searchParams.get('page')==='1'?[repo]:[]);
     if(url.pathname==='/repos/fixture-owner/fixture-repo')return Response.json(repo);
     if(url.pathname==='/repos/fixture-owner/fixture-repo/commits/main')return new Response('b'.repeat(40));
     if(url.pathname.includes('/git/trees/'))return Response.json({tree:[{path:'README.md',mode:'100644',type:'blob',sha:'c'.repeat(40)}],truncated:false});if(url.pathname.includes('/git/blobs/')){const content='AUTOMATIC_REPOSITORY_README';return Response.json({encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')});}if(url.pathname.startsWith('/repos/fixture-owner/fixture-repo/contents/')){if(url.searchParams.get('ref')!=='b'.repeat(40))throw Error('Unpinned file');const content='SYNTHETIC_REPOSITORY_FILE\n'+url.pathname.split('/').at(-1);return Response.json({type:'file',encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64'),download_url:'https://forbidden.invalid/raw'});}
     throw Error('Unexpected synthetic Git route');
    }
    if(url.hostname==='model-fixture.invalid'){
     const body=JSON.parse(init.body);fixture.systems.push(body.messages.find(message=>message.role==='system').content);
     if(fixture.failNext){fixture.failNext=false;return new Response('synthetic failure',{status:503});}
     return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Synthetic model OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    }
    if(['ipwho.is','api.open-meteo.com','geocoding-api.open-meteo.com','sousuo.www.gov.cn'].includes(url.hostname))return original(input,init);
    throw Error('Unexpected outbound domain blocked');
   };
  });
  const call=async(operation,payload={})=>{const result=await page.evaluate(async({operation,payload})=>window.workday.call(operation,payload),{operation,payload});assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
  const reject=async(operation,payload)=>{const result=await page.evaluate(async({operation,payload})=>window.workday.call(operation,payload),{operation,payload});assert.equal(result.ok,false);};
  const account=await call('git.connect',{secret:'SYNTHETIC_GIT_PAT'}),repositories=await call('git.repositories',{connectionId:account.connectionId,page:1});
  assert.equal(repositories.items.length,1);assert.equal((await call('git.repositories',{connectionId:account.connectionId,page:2})).items.length,0);
  const {private:ignored,description:ignored2,...repository}=repositories.items[0];
  await call('state.get');const project=await app.evaluate(async(_electron,repository)=>{const time=new Date().toISOString(),p={id:process.getBuiltinModule('crypto').randomUUID(),version:1,createdAt:time,updatedAt:time,name:'Synthetic legacy Git project',description:'',directory:null,repository,archived:false};await globalThis.__legacyGitService.store.transaction(()=>globalThis.__legacyGitService.store.put('projects',p));return p;},repository);
  const preview=await call('git.preview',{projectId:project.id,paths:['README.md','src/test.ts']});assert.ok(preview.content.includes('SYNTHETIC_REPOSITORY_FILE'));assert.equal(preview.commit,'b'.repeat(40));
  assert.equal((await call('state.get')).knowledge.length,0);const knowledge=await call('git.import',{token:preview.token});await reject('git.import',{token:preview.token});
  const source=await call('sources.save',{name:'Synthetic model',baseUrl:'https://model-fixture.invalid/v1',models:[{id:'fixture',name:'fixture',supportsTools:false}]}),model={sourceId:source.id,modelId:'fixture'};
  const conversation=await call('conversations.create',{projectId:project.id,date:null,model});
  const send=async(context,fail=false)=>{if(fail)await app.evaluate(()=>globalThis.__gitAPI.failNext=true);const sent=await call('chat.send',{conversationId:conversation.id,text:'Synthetic request',model,context});for(let i=0;i<100;i++){const history=await call('conversations.history',{id:conversation.id}),assistant=history.find(message=>message.requestId===sent.requestId&&message.role==='assistant');if(assistant&&assistant.status!=='running'){assert.equal(assistant.status,fail?'failed':'complete');return sent;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Synthetic chat did not complete');};
  const empty={date:null,taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[]};await send(empty);const selected={...empty,knowledgeRefs:[{id:knowledge.id,version:knowledge.version}]};const failed=await send(selected,true);
  const retry=await call('chat.retry',{conversationId:conversation.id,userMessageId:failed.userMessageId});
  for(let i=0;i<100;i++){const history=await call('conversations.history',{id:conversation.id});if(history.some(message=>message.requestId===retry.requestId&&message.role==='assistant'&&message.status==='complete'))break;if(i===99)throw Error('Synthetic retry did not complete');await new Promise(resolve=>setTimeout(resolve,50));}
  const systems=await app.evaluate(()=>globalThis.__gitAPI.systems);assert.equal(systems.length,3);assert.ok(systems[0].includes('AUTOMATIC_REPOSITORY_README'));assert.ok(!systems[0].includes('SYNTHETIC_REPOSITORY_FILE'));assert.ok(systems[1].includes('SYNTHETIC_REPOSITORY_FILE'));assert.equal(systems[1],systems[2]);
  const updated=await call('knowledge.save',{id:knowledge.id,expectedVersion:knowledge.version,name:knowledge.name,content:'UPDATED_SYNTHETIC_LOCAL_TEXT',projectId:project.id});
  await reject('chat.send',{conversationId:conversation.id,text:'Stale selection',model,context:selected});
  await call('git.disconnect',{connectionId:account.connectionId});const state=await call('state.get');assert.equal(state.gitAccount,null);assert.equal(state.knowledge[0].content,updated.content);await reject('git.preview',{projectId:project.id,paths:['README.md']});
  const publicResult={passed:true,checks:['real IPC whitelist and service','single-account connect and paged fixed-domain Git API','pinned multi-file preview and one-time knowledge import','automatic bound README and unselected manual Knowledge isolation','explicit selected actual text in model','retry freezes source snapshot and new send rejects changed knowledge version','disconnect preserves local snapshot and invalidates remote binding'],gitRequests:await app.evaluate(()=>globalThis.__gitAPI.requests),runtime:await app.evaluate(({app})=>({version:process.versions.electron,executable:process.execPath,isolated:app.getPath('userData')}))};
  assert.ok(!JSON.stringify([state,systems]).includes('SYNTHETIC_GIT_PAT'));assert.ok(!JSON.stringify(state).includes('EXCLUDED_SYNTHETIC_REMOTE_TOKEN'));
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(publicResult,null,2));console.log(JSON.stringify({passed:true,checks:publicResult.checks.length,output}));
 }finally{if(app)await app.close();await fs.rm(data,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
