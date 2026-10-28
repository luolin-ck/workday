const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

function png() {
  function crc(bytes) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
  function chunk(name, bytes) { const t = Buffer.from(name), h = Buffer.alloc(4), c = Buffer.alloc(4); h.writeUInt32BE(bytes.length); c.writeUInt32BE(crc(Buffer.concat([t, bytes]))); return Buffer.concat([h, t, bytes, c]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(80); header.writeUInt32BE(60, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(321 * 60); for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) { const i = y * 321 + 1 + x * 4; pixels[i] = 72 + x; pixels[i + 1] = 120 + y; pixels[i + 2] = 204; pixels[i + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('Comment\0PASTE_METADATA_REMOVE')), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function main(){
 const root=path.resolve(__dirname,'..'),kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'stage':'source';
 const output=process.env.WORKDAY_SMOKE_OUTPUT?path.resolve(process.env.WORKDAY_SMOKE_OUTPUT):path.join(root,'output/playwright/chat-style-'+kind);
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-chat-style-smoke-')));
 await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const checks=[],frames=[],errors=[],requests=[];let app,page;const startedAt=new Date().toISOString();
 const reply='## 已整理\n\n**合成资料** 已收到。\n\n1. 图片\n2. 文件\n\n```ts\nconst fixture = true;\n```';
 const server=http.createServer(async(req,res)=>{try{assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<20*1024*1024)}const body=JSON.parse(raw);assert.equal(body.model,'chat-style-fixture');requests.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:reply},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')}catch(e){errors.push(String(e));res.writeHead(500);res.end('Fixture error')}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const base='http://127.0.0.1:'+server.address().port;
 const call=async(op,input={})=>{const result=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(result.ok,true,JSON.stringify(result));return result.value};
 const rawCall=(op,input)=>page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});
 const until=async(test,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,40))}throw Error('Timed out: '+label)};
 const frame=async name=>{const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));assert.ok(bytes.length>1000);await fs.writeFile(path.join(output,name),Buffer.from(bytes,'base64'));frames.push(name)};
 async function fingerprint(directory){const files=[];async function visit(rel=''){for(const entry of (await fs.readdir(path.join(directory,rel),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(rel,entry.name);if(entry.isDirectory())await visit(name);else if(entry.isFile())files.push({path:name,sha256:createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex')})}}await visit();return{sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),fileCount:files.length}}
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='source'?[root]:[],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\//,r=>{errors.push('Unexpected renderer network '+r.request().url());return r.abort()});
  await app.evaluate(({app,BrowserWindow,dialog,ipcMain,net,clipboard},{data,base})=>{
    if(app.getPath('userData')!==data)throw Error('Fixture isolation mismatch');const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setSize(1500,980);w.showInactive();
    globalThis.__styleFixture={files:[],calls:[],blocked:[]};
    dialog.showOpenDialog=async options=>{if(options.title!=='添加聊天附件')throw Error('Unexpected dialog');return{canceled:false,filePaths:[...globalThis.__styleFixture.files]}};
    for(const method of ['read','readText','readImage','write','writeText','writeImage'])clipboard[method]=()=>{throw Error('System clipboard blocked in isolated smoke')};
    const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',async(event,op,input)=>{if(['sources.models','sources.test','schedules.run','mcp.discover','mcp.call','mcp.readResource','git.connect','git.repositories','git.import','projects.download','skills.approveRun','grants.save'].includes(op)){globalThis.__styleFixture.blocked.push(op);throw Error('External operation blocked')}globalThis.__styleFixture.calls.push({op,input});return original(event,op,input)});
    const originalFetch=net.fetch.bind(net);net.fetch=(url,init)=>{const target=new URL(typeof url==='string'?url:url.url??url.href);if(target.origin!==base&&!['ipwho.is','geocoding-api.open-meteo.com','api.open-meteo.com','sousuo.www.gov.cn'].includes(target.hostname)){globalThis.__styleFixture.blocked.push(target.origin);throw Error('Only localhost provider allowed')}return originalFetch(url,init)};
  },{data,base});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  const source=await call('sources.save',{name:'Chat style synthetic source',baseUrl:base+'/v1',models:[{id:'chat-style-fixture',name:'合成模型',supportsTools:true}]});const model={sourceId:source.id,modelId:'chat-style-fixture'};await call('settings.defaultModel',{model});
  const chat=await call('conversations.create',{title:'样式隔离验收',projectId:null,date:null,model});const other=await call('conversations.create',{title:'另一隔离会话',projectId:null,date:null,model});
  await page.getByRole('button',{name:'项目',exact:true}).click();const choose=async title=>page.locator('.conversation-list').getByRole('button',{name:title,exact:true}).click();await choose(chat.title);
  const picturePath=path.join(data,'fixture-image.png'),textPath=path.join(data,'资料文件名称很长用于确认截断显示与完整名称仍可查询.md');await fs.writeFile(picturePath,png());await fs.writeFile(textPath,'CHAT_STYLE_FILE_SENTINEL\n');
  await app.evaluate((_,files)=>{globalThis.__styleFixture.files=files},[picturePath,textPath]);const input=page.getByRole('textbox',{name:'消息输入',exact:true});await input.fill('/attach');await page.getByRole('option').filter({hasText:'上传附件'}).click();await page.locator('.composer-attachment-image img').waitFor();
  const preview=await page.locator('.composer-attachment-image img').getAttribute('src');assert.ok(preview.startsWith('data:image/png;base64,'));assert.equal(Buffer.from(preview.split(',')[1],'base64').includes(Buffer.from('PASTE_METADATA_REMOVE')),false);
  const picked=await app.evaluate(()=>globalThis.__styleFixture.calls.find(c=>c.op==='context.attachments.preview'));assert.ok(picked);await input.fill('请整理这些合成附件');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await until(()=>Promise.resolve(requests.length===1),'exactly one localhost model request');await until(async()=>!(await call('state.get')).conversations.find(c=>c.id===chat.id).activeRequestId,'request completed');
  let history=await call('conversations.history',{id:chat.id});const user=history.find(m=>m.role==='user'),assistant=history.find(m=>m.role==='assistant');assert.ok(user&&assistant);assert.equal(assistant.content,reply);assert.equal(await page.locator('.composer-attachment').count(),0);
  const consumed=await rawCall('context.attachments.preview',picked.input);assert.equal(consumed.ok,false);const saved=await call('messages.attachments.preview',{conversationId:chat.id,messageId:user.id});assert.deepEqual(saved,{'0':preview});
  const userElement=page.locator('article[data-message-id="'+user.id+'"]');await userElement.locator('.sent-attachment-image img').waitFor();assert.equal(await userElement.locator('.sent-attachment-image img').getAttribute('src'),preview);assert.equal(await userElement.locator('.sent-attachment-file').count(),1);assert.equal(await page.locator('.message-meta').count(),0);await page.getByRole('heading',{name:'已整理',exact:true}).waitFor();
  const wire=JSON.stringify(requests[0]);assert.match(wire,/CHAT_STYLE_FILE_SENTINEL/);assert.doesNotMatch(wire,/PASTE_METADATA_REMOVE/);assert.equal(requests[0].messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length,1);checks.push('UI picker imports normalized image and file, real localhost send consumes token, message-bound endpoint recovers exactly normalized image');
  assert.equal(await userElement.locator('.message-actions').count(),0,'User input must not render a message action bar');assert.equal(await page.locator('article.assistant .message-actions').count(),1);checks.push('user input has no action bar; assistant actions remain available');
  const bounds=await userElement.evaluate(e=>{const a=e.querySelector('.message-attachments').getBoundingClientRect(),b=e.querySelector('.message-content').getBoundingClientRect();return{ar:a.right,br:b.right}});assert.ok(Math.abs(bounds.ar-bounds.br)<2);await frame('sent-attachments-wide.png');checks.push('actual renderer groups sent file/image and user bubble on the right; assistant Markdown is semantic');
  for(const inputValue of [{conversationId:other.id,messageId:user.id},{conversationId:chat.id,messageId:assistant.id},{conversationId:chat.id,messageId:user.id,path:picturePath}])assert.equal((await rawCall('messages.attachments.preview',inputValue)).ok,false);checks.push('cross-conversation, assistant role and extra path are rejected over real IPC');
  await page.reload();await page.getByRole('navigation',{name:'全局导航'}).waitFor();await page.getByRole('button',{name:'项目',exact:true}).click();await choose(chat.title);await userElement.locator('.sent-attachment-image img').waitFor();assert.equal(await userElement.locator('.sent-attachment-image img').getAttribute('src'),preview);assert.deepEqual(await call('messages.attachments.preview',{conversationId:chat.id,messageId:user.id}),saved);await frame('history-reload.png');checks.push('persisted history reload retains same image without owner token or original path');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(660,900));await until(()=>page.evaluate(()=>innerWidth===660),'narrow viewport');await userElement.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await frame('sent-attachments-narrow.png');checks.push('real narrow Electron window has no page horizontal overflow');
  const isolation=await app.evaluate(()=>({blocked:globalThis.__styleFixture.blocked,nativeCalls:globalThis.__keychainFixture.nativeCalls,credentialCalls:globalThis.__keychainFixture.credentialCalls}));assert.deepEqual(isolation.blocked,[]);assert.equal(isolation.nativeCalls,0);assert.equal(isolation.credentialCalls,0);assert.deepEqual(errors,[]);assert.equal(requests.length,1);
  const runtime=await app.evaluate(({app},expected)=>({app:app.getAppPath(),executable:app.getPath('exe'),processExecutable:process.execPath,dataDirectoryVerified:app.getPath('userData')===expected,isolated:app.getPath('userData')}),data);assert.equal(runtime.dataDirectoryVerified,true);assert.equal(runtime.executable,runtime.processExecutable);
  const result={passed:true,kind,startedAt,completedAt:new Date().toISOString(),runtime,source:await fingerprint(path.join(root,'src')),compiled:await fingerprint(path.join(runtime.app,'dist')),scriptSha256:createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),checks,frames,actualHttpBodies:requests.length,personalData:false,realModel:false,realCredentials:false,actualMcpCalls:0,isolation};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
 }catch(e){if(page)await frame('failure.png').catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),checks,frames,errors,requests:requests.length},null,2));throw e}
 finally{if(app)await app.close().catch(()=>{});await new Promise(r=>{server.closeAllConnections();server.close(r)});await fs.rm(data,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
