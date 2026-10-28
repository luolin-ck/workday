// Model-source deletion UI acceptance. All data and credentials are synthetic and temporary.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wd-source-delete-ui-'))),output=path.resolve(process.env.WORKDAY_SMOKE_OUTPUT||path.join(root,'output/playwright/source-delete-stage'));
 await fs.mkdir(output,{recursive:true});const checks=[],errors=[];let app,page,result;
 const call=async(op,input={})=>{const r=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
 const count=()=>app.evaluate(()=>globalThis.__deleteFixture.calls.length);
 const state=()=>call('state.get');
 const frame=async name=>{await page.mouse.move(0,0);await page.screenshot({path:path.join(output,name),timeout:10000});};
 const record=s=>{checks.push(s);console.log(s);};
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:process.env.WORKDAY_ELECTRON_EXECUTABLE?[]:[root],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({BrowserWindow,ipcMain,safeStorage})=>{safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=s=>Buffer.from('sealed:'+s);safeStorage.decryptString=b=>b.toString().slice(7);const w=BrowserWindow.getAllWindows()[0];w.showInactive();w.setSize(1400,960);w.webContents.setBackgroundThrottling(false);const original=ipcMain._invokeHandlers.get('workday:call');globalThis.__deleteFixture={calls:[],fail:false,delay:false};ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',async(event,op,input)=>{if(['chat.send','chat.retry','chat.continue','sources.test','sources.models','schedules.run'].includes(op))throw Error('External operations disabled');if(op==='sources.delete'){globalThis.__deleteFixture.calls.push(input);if(globalThis.__deleteFixture.delay)await new Promise(r=>setTimeout(r,200));if(globalThis.__deleteFixture.fail)return {ok:false,error:{code:'CONFLICT',message:'合成删除失败，请重试'}};}return original(event,op,input);});});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  const a=await call('sources.save',{secret:'synthetic-only-secret',name:'合成模型源 A',baseUrl:'https://source-delete.invalid/v1',models:[{id:'model',name:'Model',supportsTools:false}]});
  const b=await call('sources.save',{name:'合成模型源 B 很长的名称用于验证删除按钮不会被内容挤压'.repeat(2),baseUrl:'https://source-delete.invalid/v1',models:[]});
  await call('settings.defaultModel',{model:{sourceId:a.id,modelId:'model'}});
  const schedule=await call('schedules.save',{name:'Synthetic schedule',prompt:'Synthetic',projectId:null,model:{sourceId:a.id,modelId:'model'},context:{taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[],date:null},spec:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'}});
  await page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name:'设置',exact:true}).click();
  const trash=s=>page.getByRole('button',{name:'删除模型源 '+s.name,exact:true});
  assert.equal(await trash(a).count(),1,'Source row needs a delete action');
  record('Model-source rows expose a named delete action');
  if(process.env.WORKDAY_DELETE_RED)return;
  const dialog=()=>page.getByRole('dialog');
  const open=async s=>{await trash(s).click();await page.getByRole('dialog',{name:'删除模型源？',exact:true}).waitFor();};
  const second=async()=>{await dialog().getByRole('button',{name:'继续删除',exact:true}).click();await page.getByRole('dialog',{name:'再次确认删除',exact:true}).waitFor();};
  const cancel=async()=>{await dialog().getByRole('button',{name:'取消',exact:true}).click();await dialog().waitFor({state:'detached'});};
  assert.equal(await page.locator('.source-list button button').count(),0);
  await open(b);assert.equal(await page.locator('.source-heading h2').innerText(),a.name);await cancel();assert.equal(await count(),0);
  await open(a);await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});assert.equal(await count(),0);
  await open(a);await dialog().getByRole('button',{name:'关闭对话框',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal(await count(),0);
  record('Delete does not select a row; first-step Cancel, Escape and Close never call deletion');
  await open(a);await second();assert.equal(await count(),0);assert.equal((await state()).sources.length,2);await frame('second-confirm.png');await cancel();assert.equal(await count(),0);
  await open(a);await second();await page.keyboard.press('Escape');await dialog().waitFor({state:'detached'});assert.equal(await count(),0);
  await open(a);await second();await dialog().getByRole('button',{name:'关闭对话框',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal(await count(),0);
  record('First confirmation only opens step two; second-step Cancel, Escape and Close preserve the source');
  await open(a);await dialog().getByRole('button',{name:'继续删除',exact:true}).dblclick();await page.getByRole('dialog',{name:'再次确认删除',exact:true}).waitFor();assert.equal(await count(),0);assert.equal(await dialog().getByRole('button',{name:'取消',exact:true}).evaluate(el=>el===document.activeElement),true);
  await dialog().getByRole('button',{name:'确认删除',exact:true}).dispatchEvent('click',{detail:2});assert.equal(await count(),0);await dialog().getByRole('button',{name:'确认删除',exact:true}).focus();await dialog().getByRole('button',{name:'确认删除',exact:true}).dispatchEvent('keydown',{key:'Enter',repeat:true});assert.equal(await count(),0);await dialog().getByRole('button',{name:'取消',exact:true}).focus();await page.keyboard.press('Enter');await dialog().waitFor({state:'detached'});assert.equal(await count(),0);record('Double-click cannot confirm both steps; second-step focus defaults to Cancel');
  await open(a);await second();await app.evaluate(()=>globalThis.__deleteFixture.fail=true);await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await dialog().getByRole('alert').waitFor();assert.ok((await state()).sources.some(s=>s.id===a.id));await cancel();await app.evaluate(()=>globalThis.__deleteFixture.fail=false);
  record('Deletion failure retains the second confirmation and source');
  await open(b);await second();const changed=await call('sources.toggle',{id:b.id,expectedVersion:b.version,enabled:false});await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await dialog().getByRole('alert').waitFor();assert.ok((await state()).sources.some(s=>s.id===b.id));await cancel();record('Stale confirmation does not delete a newer source version');
  for(const width of [1400,760]){await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setSize(w,960),width);await page.waitForFunction(w=>innerWidth===w,width,{polling:100});const geometry=await page.locator('.source-card').evaluateAll(rows=>rows.map(row=>{const r=row.getBoundingClientRect(),s=row.querySelector('.source-select').getBoundingClientRect(),b=row.querySelector('.source-delete').getBoundingClientRect();return {contained:b.right<=r.right+1&&b.left>=s.right-1,width:b.width,height:b.height,overflow:row.scrollWidth>row.clientWidth+1};}));assert.ok(geometry.every(x=>x.contained&&!x.overflow&&x.width>0&&x.height>0),JSON.stringify(geometry));await frame('rows-'+width+'.png');}
  record('Wide/narrow source rows keep long names ellipsized and action geometry intact');
  await open(a);await second();const before=await count();await app.evaluate(()=>globalThis.__deleteFixture.delay=true);await dialog().getByRole('button',{name:'确认删除',exact:true}).evaluate(el=>{el.click();el.click();});await dialog().waitFor({state:'detached'});assert.equal(await count(),before+1);
  const after=await state();assert.deepEqual(after.sources.map(s=>s.id),[b.id]);assert.equal(after.defaultModel,null);assert.equal(JSON.parse(await fs.readFile(path.join(data,'credentials.json'),'utf8'))['source:'+a.id],undefined);assert.equal(after.schedules.find(s=>s.id===schedule.id).nextRunAt,null);assert.equal(after.schedules.find(s=>s.id===schedule.id).enabled,false);assert.equal(await trash(a).count(),0);record('Only final confirmation deletes once, clears matching default and pauses dependencies');
  await open(changed);await second();await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await dialog().waitFor({state:'detached'});assert.equal((await state()).sources.length,0);await page.getByRole('heading',{name:'还没有模型源',exact:true}).waitFor();record('Deleting the last synthetic source shows the empty state');
  assert.deepEqual(errors,[]);result={passed:true,checks,errors};
 }catch(e){result={passed:false,checks,errors,error:String(e)};throw e;}
 finally{if(app)await app.close();await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result??{passed:false,checks,errors},null,2));await fs.rm(data,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
