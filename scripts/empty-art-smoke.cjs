// Scenario artwork acceptance: synthetic renderer overlays, isolated data and no external operations.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
const {setFixtureTheme}=require('./appearance-fixture.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),stage=!!process.env.WORKDAY_ELECTRON_EXECUTABLE;
 const output=path.join(root,'output/playwright',stage?'empty-art-refresh-stage':'empty-art-refresh-source');await fs.mkdir(output,{recursive:true});
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wd-empty-art-refresh-')));let app,page,result;const checks=[],errors=[],screenshots=[];
 const nav=name=>page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name,exact:true});
 const tab=name=>page.getByRole('tab',{name,exact:true});
 const frame=async name=>{if(stage){await page.mouse.move(0,0);await page.screenshot({path:path.join(output,name),timeout:10000,animations:'disabled'});screenshots.push(name);}};
 async function mode(value){await app.evaluate((_,v)=>{globalThis.__emptyArt.mode=v;},value);await page.reload();await nav('Home').waitFor();}
 async function imageCheck(locator,label,maxWidth=128,maxHeight=128){
  await locator.waitFor({state:'visible'});const g=await locator.evaluate(async el=>{await el.decode();const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {src:el.currentSrc,width:r.width,height:r.height,naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,x:r.x,y:r.y,right:r.right,bottom:r.bottom,fit:s.objectFit,visible:r.width>0&&r.height>0,overflow:el.scrollWidth>el.clientWidth+1,viewportWidth:innerWidth};});
  assert.ok(g.visible&&g.naturalWidth>256&&g.naturalHeight>256,label);assert.ok(g.width<=maxWidth+.5&&g.height<=maxHeight+.5,JSON.stringify({label,...g}));assert.ok(g.right<=g.viewportWidth+1&&!g.overflow,JSON.stringify({label,...g}));assert.ok(g.fit==='contain'||Math.abs(g.width/g.height-g.naturalWidth/g.naturalHeight)<.02,label);
  const bytes=await fs.readFile(new URL(g.src));assert.equal(bytes.subarray(1,4).toString(),'PNG');g.sha256=crypto.createHash('sha256').update(bytes).digest('hex');return {label,...g};
 }
 async function emptyCheck(art,title,label,compact=false){
  const box=page.locator('.empty').filter({has:page.getByRole('heading',{name:title,exact:true})});const img=box.locator('img[data-empty-art]');assert.equal(await box.count(),1);assert.equal(await img.getAttribute('data-empty-art'),art);assert.equal(await img.getAttribute('alt'),'');assert.equal(await img.getAttribute('aria-hidden'),'true');assert.equal(await box.locator('svg').count(),0);
  const g=await imageCheck(img,label,compact?64:128,compact?64:128);const placement=await box.evaluate(el=>{const a=el.querySelector('img').getBoundingClientRect(),h=el.querySelector('h3').getBoundingClientRect(),p=el.querySelector('p').getBoundingClientRect(),b=el.getBoundingClientRect();return {width:b.width,height:b.height,overlap:a.bottom>h.y+1||h.bottom>p.y+1,overflow:el.scrollWidth>el.clientWidth+1};});assert.ok(!placement.overlap&&!placement.overflow,JSON.stringify(placement));checks.push({...g,art,placement});
 }
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:stage?[]:[process.env.WORKDAY_EMPTY_APP_ROOT||root],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\//,r=>r.abort());
  await app.evaluate(({BrowserWindow,ipcMain})=>{
   const w=BrowserWindow.getAllWindows()[0];w.showInactive();w.setSize(1500,960);w.webContents.setBackgroundThrottling(false);
   globalThis.__emptyArt={mode:'empty',external:[]};const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');
   ipcMain.handle('workday:call',async(e,op,input)=>{
    if(['chat.send','chat.retry','chat.continue','sources.test','sources.models','schedules.run','schedules.toggle','mcp.discover','mcp.call','mcp.readResource','git.connect','git.repositories','git.import','skills.approveRun'].includes(op)){globalThis.__emptyArt.external.push(op);throw Error('External operation blocked in empty art fixture');}
    if(op==='schedules.runs')return {ok:true,value:[]};
    const response=await original(e,op,input);if(op!=='state.get'||!response.ok)return response;
    const entity={id:'fixture-schedule',version:1,createdAt:'2026-01-01',updatedAt:'2026-01-01'};
    const state={...response.value,tasks:[],sources:[],schedules:[],skills:[],mcpServers:[],plugins:[],knowledge:[],defaultModel:null};
    if(globalThis.__emptyArt.mode==='history')state.schedules=[{...entity,name:'合成计划',prompt:'Fixture only',model:{sourceId:'fixture-source',modelId:'fixture'},projectId:null,context:{date:null,taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[]},spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'},enabled:false,status:'paused',pauseReason:null,nextRunAt:null,nextSlot:null,sourceVersion:1}];
    if(globalThis.__emptyArt.mode==='populated'){
     state.skills=[{...entity,id:'fixture-skill',name:'合成 Skill',description:'合成内容',content:'# 合成',enabled:true,ownerPluginId:null}];
     state.mcpServers=[{...entity,id:'fixture-mcp',name:'合成 MCP',transport:'http',command:'',args:[],url:'https://fixture.invalid/mcp',enabled:false,configVersion:1,tools:[],resources:[],prompts:[]}];
     state.plugins=[{...entity,id:'fixture-plugin',pluginKey:'fixture-plugin',name:'合成 Plugin',description:'合成内容',enabled:true,packageVersion:'1.0.0',skillIds:[],mcpIds:[]}];
    }
    return {...response,value:state};
   });
  });
  await page.reload();await nav('Home').waitFor();
  for(const theme of ['mono','blue','custom']){
   await setFixtureTheme(page,theme);
   if(theme==='custom'){
    await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('workday-appearance',1);req.onsuccess=()=>{const db=req.result,t=db.transaction('appearance','readwrite');t.objectStore('appearance').put({schemaVersion:1,theme:'custom',custom:{canvas:'#222730',surface:'#2d333e',text:'#f0f2f6',muted:'#bbc4d0',accent:'#b9d4f0',border:'#495362',card:'#323a46'},background:null},'current');t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>reject(t.error);};}));await page.reload();await nav('Home').waitFor();
   }
   for(const width of [1500,660]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,960),width);await page.waitForFunction(width=>innerWidth===width,width);await mode('empty');
    await nav('Home').click();checks.push(await imageCheck(page.locator('.day-empty img'),'tasks-'+theme+'-'+width,160,160));
    await nav('插件').click();for(const [name,art,title] of [['Skill','skills','为 AI 准备一套工作方法'],['MCP','mcp','连接一个可信的 MCP 服务'],['Plugin','plugins','以组合包管理能力']]){await tab(name).click();await emptyCheck(art,title,name+'-'+theme+'-'+width);assert.equal(await page.getByRole('button',{name:'新增',exact:true}).isVisible(),true);if(theme==='mono'||theme==='custom'&&width===660)await frame(`${theme}-${width}-${art}.png`);}
    await nav('知识库').click();await emptyCheck('knowledge','让资料成为可用的上下文','knowledge-'+theme+'-'+width);
    await nav('定时任务').click();await emptyCheck('schedules','为重复工作建立一个节奏','schedules-'+theme+'-'+width);
    await nav('设置').click();await tab('模型源').click();await emptyCheck('models','添加模型源','models-compact-'+theme+'-'+width,true);await emptyCheck('models','还没有模型源','models-'+theme+'-'+width);assert.equal(await page.getByRole('button',{name:'添加模型源',exact:true}).isVisible(),true);if(theme==='mono'||theme==='custom'&&width===660)await frame(`${theme}-${width}-models.png`);
    await tab('主题').click();await page.locator('.background-placeholder').scrollIntoViewIfNeeded();const thumb=await imageCheck(page.locator('img.background-placeholder'),'background-'+theme+'-'+width,52,40);assert.equal(thumb.fit,'contain');assert.equal(thumb.width,52);assert.equal(thumb.height,40);checks.push(thumb);if(theme==='mono'||theme==='custom'&&width===660)await frame(`${theme}-${width}-background.png`);
    await mode('history');await nav('定时任务').click();assert.equal(await page.locator('.empty').count(),0);await page.getByRole('button',{name:'运行记录',exact:true}).click();await emptyCheck('runHistory','还没有运行记录','history-'+theme+'-'+width);if(theme==='mono'||theme==='custom'&&width===660)await frame(`${theme}-${width}-history.png`);await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
    console.log(JSON.stringify({theme,width,passed:true,images:10}));
   }
  }
  await mode('populated');await nav('插件').click();for(const name of ['Skill','MCP','Plugin']){await tab(name).click();assert.equal(await page.locator('.empty:visible').count(),0);const g=await imageCheck(page.locator('.component-icon:visible').first(),'populated-'+name,40,40);checks.push(g);}
  await page.getByRole('button',{name:'查看 合成 Plugin',exact:true}).click();await page.getByRole('button',{name:'管理',exact:true}).click();const manager=page.getByRole('dialog');assert.equal(await manager.locator('.plugin-management-empty').count(),2);assert.equal(await manager.locator('.empty-art').count(),0);await frame('compact-plugin-management.png');await manager.getByRole('button',{name:'关闭',exact:true}).click();await manager.waitFor({state:'detached'});
  await nav('设置').click();await tab('主题').click();const png=await fs.readFile(path.join(root,'assets/illustrations/empty-states/knowledge.png'));await page.locator('input[type=file]').setInputFiles({name:'synthetic-background.png',mimeType:'image/png',buffer:png});await page.locator('img.background-preview').waitFor();assert.equal(await page.locator('.background-placeholder').count(),0);await page.locator('img.background-preview').evaluate(el=>el.decode());
  assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__emptyArt.external),[]);result={passed:true,kind:stage?'stage':'source',checks,screenshots,errors,externalRequests:0,personalData:false,compactManagementPreserved:true,userBackgroundPreserved:true};
 }catch(e){result={passed:false,checks,screenshots,errors,error:String(e)};throw e;}
 finally{if(app)await app.close();await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result??{passed:false},null,2));await fs.rm(data,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
