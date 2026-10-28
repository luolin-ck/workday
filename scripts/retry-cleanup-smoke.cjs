// Isolated retry UI acceptance; all model responses are local synthetic SSE.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
async function fingerprint(directory){const files=[];async function visit(rel=''){for(const item of(await fs.readdir(path.join(directory,rel),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(rel,item.name);if(item.isDirectory())await visit(name);else if(item.isFile())files.push({path:name,sha256:createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex')});}}await visit();return{sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),fileCount:files.length};}
async function main(){
 const root=path.resolve(__dirname,'..'),kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'stage':'source';
 const output=process.env.WORKDAY_SMOKE_OUTPUT?path.resolve(process.env.WORKDAY_SMOKE_OUTPUT):path.join(root,'output/playwright/retry-cleanup-'+kind);
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-retry-cleanup-smoke-')));
 await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const checks=[],frames=[],errors=[],requests=[],pending=new Map(),attempts=new Map();let app,page;const startedAt=new Date().toISOString();
 const usage=n=>({prompt_tokens:100+n,completion_tokens:10+n,total_tokens:110+2*n});
 const finish=(entry,success)=>{if(entry.res.destroyed)return;if(success)entry.res.write(event({choices:[{delta:{},finish_reason:'stop'}]}));entry.res.write(event({choices:[],usage:usage(entry.attempt)}));entry.res.end(success?'data: [DONE]\n\n':'');pending.delete(entry.key);};
 const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<1024*1024);}
  const body=JSON.parse(raw);assert.equal(body.model,'retry-cleanup-fixture');assert.deepEqual(body.stream_options,{include_usage:true});
  const text=body.messages.filter(m=>m.role==='user').at(-1)?.content;assert.equal(typeof text,'string');const fixture=/RETRY_(MAIN|PREFLIGHT|OTHER)/.exec(text)?.[1];assert.ok(fixture);
  const attempt=(attempts.get(fixture)||0)+1;attempts.set(fixture,attempt);requests.push({fixture,attempt});
  if(fixture==='MAIN'&&attempt===1){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic retry fixture unavailable'}}));return;}
  const entry={fixture,attempt,res,key:fixture+':'+attempt};res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write(event({choices:[{delta:{content:fixture==='MAIN'&&attempt===4?'当前重试成功回复。':'合成尝试 '+attempt+' 的片段。'},finish_reason:null}]}));
  if(fixture==='MAIN'&&attempt>1){pending.set(entry.key,entry);return;}
  finish(entry,fixture==='OTHER');
 }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end('Fixture error');}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const base='http://127.0.0.1:'+server.address().port;
 const call=async(op,input={})=>{const result=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
 const until=async(test,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await test())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Timed out: '+label);};
 const history=id=>call('conversations.history',{id,_fixtureBypass:true});
 const frame=async name=>{const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));assert.ok(bytes.length>1000);await fs.writeFile(path.join(output,name),Buffer.from(bytes,'base64'));frames.push(name);};
 const article=id=>page.locator('article[data-message-id="'+id+'"]');
 const assertRefresh=async(id,label='重试此轮')=>{const row=article(id);await row.getByRole('button',{name:label,exact:true}).waitFor();assert.equal(await row.locator('.message-status').getByRole('button',{name:'重试此轮',exact:true}).count(),0,'Retry must only appear as a toolbar refresh icon');const button=row.locator('.message-actions').getByRole('button',{name:label,exact:true});assert.equal(await button.count(),1);assert.equal((await button.textContent()).trim(),'');assert.equal(await button.locator('svg').count(),1);};
 const waitIdle=async id=>until(async()=>!(await call('state.get')).conversations.find(c=>c.id===id)?.activeRequestId,'request terminal');
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='source'?[root]:[],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\//,route=>{errors.push('Unexpected renderer network '+route.request().url());return route.abort();});
  await app.evaluate(({app,BrowserWindow,dialog,ipcMain,net,clipboard},{data,base})=>{
   if(app.getPath('userData')!==data)throw Error('Fixture isolation mismatch');const window=BrowserWindow.getAllWindows()[0];window.webContents.setBackgroundThrottling(false);window.setSize(1200,900);window.showInactive();
   const f=globalThis.__retryFixture={calls:[],blocked:[],retryResults:[],historyWaiters:[],heldHistory:0,holdHistory:false,legacyChat:null,syntheticTools:false};
   dialog.showOpenDialog=async()=>{throw Error('File picker blocked');};for(const method of ['read','readText','readImage','write','writeText','writeImage'])clipboard[method]=()=>{throw Error('Clipboard blocked');};
   const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',async(event,op,input)=>{
    if(['sources.models','sources.test','schedules.run','mcp.discover','mcp.call','mcp.readResource','git.connect','git.repositories','git.import','projects.download','skills.approveRun','grants.save'].includes(op)){f.blocked.push(op);throw Error('External operation blocked');}
    f.calls.push(op);const bypass=op==='conversations.history'&&input?._fixtureBypass;const clean=bypass?{id:input.id}:input;
    const result=await original(event,op,clean);if(op==='chat.retry')f.retryResults.push(result);
    if(op==='conversations.history'&&!bypass&&result.ok){
     if(f.holdHistory){f.heldHistory++;await new Promise(resolve=>f.historyWaiters.push(resolve));}
     if(input.id===f.legacyChat){
      const rows=result.value.map(m=>({...m})),first=rows.find(m=>m.role==='assistant');
      if(first){delete first.replyToMessageId;if(first.snapshot){first.snapshot={...first.snapshot};delete first.snapshot.userMessageId;}}
      if(f.syntheticTools&&first){first.media=[{id:'synthetic-hidden-media',mime:'image/png',width:1,height:1,path:'fixture.png'}];const tool={id:'synthetic-preserved-tool',conversationId:input.id,requestId:first.requestId,role:'tool',content:'合成工具证据',status:'complete',createdAt:first.createdAt,toolCalls:[{id:'synthetic-tool-call',name:'fixture-read',arguments:'{}',result:'合成工具证据',status:'success'}]};rows.splice(rows.indexOf(first)+1,0,tool);}
      return {...result,value:rows};
     }
    }
    return result;
   });
   const originalFetch=net.fetch.bind(net);net.fetch=(url,init)=>{const target=new URL(typeof url==='string'?url:url.url??url.href);if(target.origin!==base&&!['ipwho.is','geocoding-api.open-meteo.com','api.open-meteo.com','sousuo.www.gov.cn'].includes(target.hostname)){f.blocked.push(target.origin);throw Error('Only localhost provider allowed');}return originalFetch(url,init);};
  },{data,base});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  const source=await call('sources.save',{name:'Retry isolated source',baseUrl:base+'/v1',models:[{id:'retry-cleanup-fixture',name:'合成重试模型',supportsTools:true}]}),model={sourceId:source.id,modelId:'retry-cleanup-fixture'};await call('settings.defaultModel',{model});
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const choose=title=>page.locator('.conversation-list').getByRole('button',{name:title,exact:true}).click();
  const create=async fixture=>{const chat=await call('conversations.create',{title:'重试隔离 '+fixture,projectId:null,date:null,model});await choose(chat.title);await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('RETRY_'+fixture+'：仅用于隔离验收。');await page.getByRole('button',{name:'发送消息',exact:true}).click();await until(()=>attempts.has(fixture),'initial local response');await waitIdle(chat.id);return chat;};
  const main=await create('MAIN');let rows=await history(main.id),first=rows.find(m=>m.role==='assistant'),user=rows.find(m=>m.role==='user');assert.equal(first.status,'failed');assert.equal(first.content,'');await assertRefresh(first.id);const originalMetrics=structuredClone(first.metrics);
  assert.equal(await page.locator('article.assistant').count(),1);checks.push('Initial localhost failure remains visible and retryable');await frame('initial-failure.png');
  await app.evaluate(()=>{globalThis.__retryFixture.holdHistory=true;});
  await article(first.id).getByRole('button',{name:'重试此轮',exact:true}).click();
  await until(()=>pending.has('MAIN:2'),'retry stream started');await until(async()=>(await app.evaluate(()=>globalThis.__retryFixture.retryResults.length))===1,'retry accepted');
  await until(async()=>await article(first.id).count()===0,'obsolete failure hidden before history release');
  assert.equal(await page.locator('article.assistant').count(),1);assert.equal(await page.getByRole('button',{name:'重试此轮',exact:true}).count(),0);assert.match(await page.locator('article.assistant').innerText(),/正在生成/);
  checks.push('Accepted retry with first stream delta and held history replaces obsolete failure immediately');await frame('retry-running-delayed-history.png');
  await app.evaluate(()=>{const f=globalThis.__retryFixture;f.holdHistory=false;for(const resolve of f.historyWaiters.splice(0))resolve();});
  finish(pending.get('MAIN:2'),false);await waitIdle(main.id);rows=await history(main.id);let current=rows.filter(m=>m.role==='assistant').at(-1);assert.equal(current.status,'failed');await assertRefresh(current.id);assert.equal(await page.locator('article.assistant').count(),1);assert.equal(await article(first.id).count(),0);checks.push('Retry failing again shows only latest failed attempt and one retry action');
  await article(current.id).getByRole('button',{name:'重试此轮',exact:true}).click();await until(()=>pending.has('MAIN:3'),'cancel attempt started');
  await page.getByRole('button',{name:'停止',exact:true}).click();await waitIdle(main.id);rows=await history(main.id);current=rows.filter(m=>m.role==='assistant').at(-1);assert.equal(current.status,'cancelled');await assertRefresh(current.id);assert.equal(await page.locator('article.assistant').count(),1);checks.push('Cancelled retry replaces previous error and remains retryable');
  await article(current.id).getByRole('button',{name:'重试此轮',exact:true}).click();await until(()=>pending.has('MAIN:4'),'successful retry started');finish(pending.get('MAIN:4'),true);await waitIdle(main.id);rows=await history(main.id);current=rows.filter(m=>m.role==='assistant').at(-1);assert.equal(current.status,'complete');await article(current.id).waitFor();await assertRefresh(current.id,'重新生成');
  assert.equal(await page.locator('article.assistant').count(),1);assert.equal(await page.locator('article.user').count(),1);assert.equal(await page.getByRole('button',{name:'重试此轮',exact:true}).count(),0);assert.equal(await page.locator('.message-status.failed,.message-status.cancelled').count(),0);assert.equal(rows.filter(m=>m.role==='assistant').length,4);assert.deepEqual(rows.find(m=>m.id===first.id).metrics,originalMetrics);assert.deepEqual(current.metrics.usage,{inputTokens:104,outputTokens:14,totalTokens:118});assert.equal(current.replyToMessageId,user.id);
  await article(current.id).getByRole('button',{name:'消息详情',exact:true}).click();const details=page.getByRole('dialog',{name:'消息详情',exact:true});await details.waitFor();assert.match(await details.innerText(),/118/);await frame('retry-success-metrics.png');await page.keyboard.press('Escape');await details.waitFor({state:'detached'});checks.push('Successful retry hides all previous failed/cancelled articles; stored attempts and their metrics remain unchanged; current metrics are independent');
  await app.evaluate((_,id)=>{globalThis.__retryFixture.legacyChat=id;globalThis.__retryFixture.syntheticTools=true;},main.id);
  await page.reload();await page.getByRole('navigation',{name:'全局导航'}).waitFor();await page.getByRole('button',{name:'项目',exact:true}).click();await choose(main.title);await article(current.id).waitFor();await assertRefresh(current.id,'重新生成');
  assert.equal(await article(first.id).count(),0);assert.equal(await page.locator('article.assistant').count(),1);assert.equal(await article('synthetic-preserved-tool').count(),1);await article('synthetic-preserved-tool').locator('summary').click();assert.match(await article('synthetic-preserved-tool').innerText(),/合成工具证据/);assert.equal(await app.evaluate(()=>globalThis.__retryFixture.calls.filter(op=>op==='media.read').length),0);checks.push('Controlled legacy-history fixture: no replyTo on initial failure, complete independent tool evidence preserved, superseded media not mounted after reload');await frame('legacy-tool-evidence.png');
  const other=await create('OTHER');const otherReply=(await history(other.id)).find(m=>m.role==='assistant');assert.equal(otherReply.status,'complete');await article(otherReply.id).waitFor();assert.equal(await page.locator('article.assistant').count(),1);await choose(main.title);await article(current.id).waitFor();assert.equal(await page.locator('article.assistant').count(),1);checks.push('Switching conversations preserves independent successful replies without leaking retry visibility');
  const preflight=await create('PREFLIGHT'),before=await history(preflight.id),failed=before.find(m=>m.role==='assistant');await assertRefresh(failed.id);const currentSource=(await call('state.get')).sources.find(s=>s.id===source.id);await call('sources.toggle',{id:source.id,expectedVersion:currentSource.version,enabled:false});
  const priorResults=await app.evaluate(()=>globalThis.__retryFixture.retryResults.length);await article(failed.id).getByRole('button',{name:'重试此轮',exact:true}).click();await until(async()=>await app.evaluate(()=>globalThis.__retryFixture.retryResults.length)>priorResults,'preflight rejection returned');assert.equal(await app.evaluate(()=>globalThis.__retryFixture.retryResults.at(-1).ok),false);assert.deepEqual(await history(preflight.id),before);assert.equal(await article(failed.id).count(),1);assert.equal(await page.getByRole('button',{name:'重试此轮',exact:true}).count(),1);assert.equal(attempts.get('PREFLIGHT'),1);checks.push('Actual disabled-source preflight rejection keeps original error/action and adds no request or history');await frame('preflight-rejected.png');
  const isolation=await app.evaluate(()=>({blocked:globalThis.__retryFixture.blocked,nativeCalls:globalThis.__keychainFixture.nativeCalls,credentialCalls:globalThis.__keychainFixture.credentialCalls,heldHistory:globalThis.__retryFixture.heldHistory}));assert.deepEqual(isolation.blocked,[]);assert.equal(isolation.nativeCalls,0);assert.equal(isolation.credentialCalls,0);assert.ok(isolation.heldHistory>0);assert.deepEqual(errors,[]);assert.equal(requests.length,6);
  const runtime=await app.evaluate(({app},expected)=>({app:app.getAppPath(),executable:app.getPath('exe'),processExecutable:process.execPath,dataDirectoryVerified:app.getPath('userData')===expected}),data);assert.equal(runtime.dataDirectoryVerified,true);assert.equal(runtime.executable,runtime.processExecutable);
  const result={passed:true,kind,startedAt,completedAt:new Date().toISOString(),runtime,source:await fingerprint(path.join(root,'src')),compiled:await fingerprint(path.join(runtime.app,'dist')),scriptSha256:createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),checks,frames,actualHttpBodies:requests.length,requests,personalData:false,realModel:false,realCredentials:false,actualMcpCalls:0,controlledHistoryFixture:true,isolation};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
 }catch(error){if(page)await frame('failure.png').catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,frames,errors,requests},null,2));throw error;}
 finally{if(app)await app.close().catch(()=>{});await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});await fs.rm(data,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
