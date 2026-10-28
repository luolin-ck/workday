// Isolated Electron acceptance: localhost SSE -> service -> persisted history -> actual UI.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const known={prompt_tokens:222031,completion_tokens:10866,total_tokens:232897,prompt_tokens_details:{cached_tokens:222025,cache_write_tokens:81536}};
const normalized={inputTokens:222031,outputTokens:10866,totalTokens:232897,cachedInputTokens:222025,cacheWriteTokens:81536};
async function fingerprint(directory){const files=[];async function visit(rel=''){for(const item of (await fs.readdir(path.join(directory,rel),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(rel,item.name);if(item.isDirectory())await visit(name);else if(item.isFile())files.push({path:name,sha256:createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex')})}}await visit();return{sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),fileCount:files.length}}
async function main(){
 const root=path.resolve(__dirname,'..'),kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'stage':'source';
 const output=process.env.WORKDAY_SMOKE_OUTPUT?path.resolve(process.env.WORKDAY_SMOKE_OUTPUT):path.join(root,'output/playwright/message-metrics-'+kind);
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-message-metrics-smoke-')));
 await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const checks=[],frames=[],errors=[],requests=[],observed=[];let app,page;const startedAt=new Date().toISOString();
 const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<1024*1024)}
  const body=JSON.parse(raw);assert.equal(body.model,'message-metrics-fixture');assert.deepEqual(body.stream_options,{include_usage:true});
  const content=body.messages.filter(m=>m.role==='user').at(-1)?.content;assert.equal(typeof content,'string');const fixture=/METRICS_(KNOWN|ZERO|MISSING|PARTIAL)/.exec(content)?.[1];assert.ok(fixture);requests.push({fixture,body});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write(event({choices:[{delta:{content:'这是一条合成指标回复。'},finish_reason:null}]}));
  await new Promise(resolve=>setTimeout(resolve,60));
  if(fixture==='PARTIAL'){res.end(event({choices:[],usage:known}));return;}
  res.write(event({choices:[{delta:{},finish_reason:'stop'}]}));
  if(fixture!=='MISSING')res.write(event({choices:[],usage:fixture==='ZERO'?{prompt_tokens:0,completion_tokens:0,total_tokens:0}:known}));
  res.end('data: [DONE]\n\n');
 }catch(error){errors.push(String(error));if(!res.headersSent)res.writeHead(500);res.end('Fixture error')}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const base='http://127.0.0.1:'+server.address().port;
 const call=async(op,input={})=>{const result=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(result.ok,true,JSON.stringify(result));return result.value};
 const until=async(test,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await test())return;await new Promise(resolve=>setTimeout(resolve,40))}throw Error('Timed out: '+label)};
 const frame=async name=>{const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));assert.ok(bytes.length>1000);await fs.writeFile(path.join(output,name),Buffer.from(bytes,'base64'));frames.push(name)};
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='source'?[root]:[],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\//,route=>{errors.push('Unexpected renderer network '+route.request().url());return route.abort()});
  await app.evaluate(({app,BrowserWindow,dialog,ipcMain,net,clipboard},{data,base})=>{
   if(app.getPath('userData')!==data)throw Error('Fixture isolation mismatch');const window=BrowserWindow.getAllWindows()[0];window.webContents.setBackgroundThrottling(false);window.setSize(1200,900);window.showInactive();globalThis.__metricsFixture={calls:[],blocked:[]};
   dialog.showOpenDialog=async()=>{throw Error('No file picker permitted in metrics smoke')};
   for(const method of ['read','readText','readImage','write','writeText','writeImage'])clipboard[method]=()=>{throw Error('System clipboard blocked in isolated smoke')};
   const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',async(event,op,input)=>{
    if(['sources.models','sources.test','schedules.run','mcp.discover','mcp.call','mcp.readResource','git.connect','git.repositories','git.import','projects.download','skills.approveRun','grants.save'].includes(op)){globalThis.__metricsFixture.blocked.push(op);throw Error('External operation blocked')}
    globalThis.__metricsFixture.calls.push(op);return original(event,op,input);
   });
   const originalFetch=net.fetch.bind(net);net.fetch=(url,init)=>{const target=new URL(typeof url==='string'?url:url.url??url.href);if(target.origin!==base&&!['ipwho.is','geocoding-api.open-meteo.com','api.open-meteo.com','sousuo.www.gov.cn'].includes(target.hostname)){globalThis.__metricsFixture.blocked.push(target.origin);throw Error('Only localhost provider allowed')}return originalFetch(url,init)};
  },{data,base});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  const source=await call('sources.save',{name:'Message metrics synthetic source',baseUrl:base+'/v1',models:[{id:'message-metrics-fixture',name:'合成指标模型',supportsTools:true}]});
  const model={sourceId:source.id,modelId:'message-metrics-fixture'};await call('settings.defaultModel',{model});
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const choose=async title=>page.locator('.conversation-list').getByRole('button',{name:title,exact:true}).click();
  const tooltip=page.getByRole('tooltip'),dialog=page.getByRole('dialog',{name:'消息详情',exact:true});
  const values=locator=>locator.locator('.message-metrics').evaluate(e=>Object.fromEntries([...e.querySelectorAll('dt')].map(node=>[node.textContent,node.nextElementSibling.textContent])));
  const focus=async id=>{await page.getByRole('textbox',{name:'消息输入',exact:true}).click();await tooltip.waitFor({state:'detached'});const article=page.locator('article[data-message-id="'+id+'"]'),button=article.getByRole('button',{name:'消息详情',exact:true});await article.getByRole('button',{name:'复制消息',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await button.evaluate(e=>e.matches(':focus-visible')),true);await tooltip.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('[role="tooltip"]')].some(e=>getComputedStyle(e).opacity==='1'));return values(tooltip)};
  let saved;
  for(const fixture of ['KNOWN','ZERO','MISSING','PARTIAL']){
   const chat=await call('conversations.create',{title:'指标隔离 '+fixture,projectId:null,date:null,model});await choose(chat.title);
   await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('METRICS_'+fixture+'：请回复合成验收内容。');await page.getByRole('button',{name:'发送消息',exact:true}).click();
   await until(()=>requests.some(item=>item.fixture===fixture),'localhost request '+fixture);
   await until(async()=>!(await call('state.get')).conversations.find(item=>item.id===chat.id)?.activeRequestId,'terminal request '+fixture);
   const history=await call('conversations.history',{id:chat.id}),assistant=history.find(m=>m.role==='assistant'),user=history.find(m=>m.role==='user');
   assert.ok(assistant&&user);assert.equal(user.metrics,undefined);assert.equal(assistant.status,fixture==='PARTIAL'?'failed':'complete');
   const metrics=assistant.metrics;assert.ok(metrics);assert.ok(Number.isSafeInteger(metrics.durationMs)&&metrics.durationMs>=0);assert.ok(Number.isFinite(Date.parse(metrics.completedAt)));assert.equal(metrics.rounds,1);assert.equal(metrics.completedRounds,fixture==='PARTIAL'?0:1);
   if(fixture==='MISSING')assert.equal(metrics.usage,undefined);else assert.deepEqual(metrics.usage,fixture==='ZERO'?{inputTokens:0,outputTokens:0,totalTokens:0}:normalized);
   const shown=await focus(assistant.id);assert.equal(shown['状态'],fixture==='PARTIAL'?'失败':'成功');assert.notEqual(shown['耗时'],'未记录');assert.notEqual(shown['完成时间'],'未记录');
   if(fixture==='MISSING'){assert.equal(shown['总 Token'],'未提供');assert.equal(shown['输入'],'未提供');assert.equal(shown['缓存命中'],undefined)}
   else if(fixture==='ZERO'){assert.equal(shown['总 Token'],'0');assert.equal(shown['输入'],'0');assert.equal(shown['输出'],'0');assert.equal(shown['缓存命中'],undefined)}
   else{const suffix=fixture==='PARTIAL'?'部分统计':'';assert.equal(shown['总 Token'],'232,897'+suffix);assert.equal(shown['输入'],'222,031'+suffix);assert.equal(shown['输出'],'10,866'+suffix);assert.equal(shown['缓存命中'],'222,025'+suffix);assert.equal(shown['缓存写入'],'81,536'+suffix)}
   assert.equal(await tooltip.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(32, 34, 38)');
   await frame(fixture.toLowerCase()+'-focus.png');observed.push({fixture,status:assistant.status,metrics,shown});checks.push(fixture+': actual localhost include_usage request, persisted metrics and focused UI values agree');
   if(fixture==='KNOWN'){
    const info=page.locator('article[data-message-id="'+assistant.id+'"]').getByRole('button',{name:'消息详情',exact:true});await info.press('Enter');await dialog.waitFor();await tooltip.waitFor({state:'detached'});assert.deepEqual(await values(dialog),shown);
    assert.equal(await dialog.locator('.message-info-dialog-header').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(32, 34, 38)');
    await page.waitForFunction(()=>{let e=document.querySelector('[role="dialog"]');if(!e)return false;for(;e;e=e.parentElement)if(Number(getComputedStyle(e).opacity)<1)return false;return true});await frame('known-dialog.png');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});saved={chat,id:assistant.id,metrics,shown};checks.push('Enter detail shows same provider values as focus and Escape closes it');
   }
  }
  await page.reload();await page.getByRole('navigation',{name:'全局导航'}).waitFor();await page.getByRole('button',{name:'项目',exact:true}).click();await choose(saved.chat.title);
  const persisted=(await call('conversations.history',{id:saved.chat.id})).find(m=>m.id===saved.id);assert.deepEqual(persisted.metrics,saved.metrics);assert.deepEqual(await focus(saved.id),saved.shown);await frame('known-reloaded.png');checks.push('history survives application renderer reload with unchanged values and duration');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(660,900));await until(()=>page.evaluate(()=>innerWidth===660),'narrow viewport');await focus(saved.id);const bounds=await tooltip.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=660);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await tooltip.evaluate(e=>e.scrollWidth>e.clientWidth),false);await frame('known-narrow.png');checks.push('660px isolated Electron window keeps details within viewport without horizontal overflow');
  const isolation=await app.evaluate(()=>({blocked:globalThis.__metricsFixture.blocked,nativeCalls:globalThis.__keychainFixture.nativeCalls,credentialCalls:globalThis.__keychainFixture.credentialCalls}));assert.deepEqual(isolation.blocked,[]);assert.equal(isolation.nativeCalls,0);assert.equal(isolation.credentialCalls,0);assert.deepEqual(errors,[]);assert.equal(requests.length,4);
  const runtime=await app.evaluate(({app},expected)=>({app:app.getAppPath(),executable:app.getPath('exe'),processExecutable:process.execPath,dataDirectoryVerified:app.getPath('userData')===expected,isolated:app.getPath('userData')}),data);assert.equal(runtime.dataDirectoryVerified,true);assert.equal(runtime.executable,runtime.processExecutable);
  const result={passed:true,kind,startedAt,completedAt:new Date().toISOString(),runtime,source:await fingerprint(path.join(root,'src')),compiled:await fingerprint(path.join(runtime.app,'dist')),scriptSha256:createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),checks,frames,observed,actualHttpBodies:requests.length,personalData:false,realModel:false,realCredentials:false,actualMcpCalls:0,isolation};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
 }catch(error){if(page)await frame('failure.png').catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,frames,errors,requests:requests.length,observed},null,2));throw error}
 finally{if(app)await app.close().catch(()=>{});await new Promise(resolve=>{server.closeAllConnections();server.close(resolve)});await fs.rm(data,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
