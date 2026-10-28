const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),data=await fs.mkdtemp(path.join(os.tmpdir(),'workday-keychain-ui-'));
 const output=path.join(root,'output/playwright',process.env.WORKDAY_ELECTRON_EXECUTABLE?'keychain-stage':'keychain-source');await fs.mkdir(output,{recursive:true});
 const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
 let app,page;const checks=[];const errors=[];
 try{
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:process.env.WORKDAY_ELECTRON_EXECUTABLE?[]:[root],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await app.evaluate(({BrowserWindow,ipcMain})=>{
   BrowserWindow.getAllWindows()[0].hide();BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
   const original=ipcMain._invokeHandlers.get('workday:call');globalThis.__keychainExternalOperations=[];
   ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',(event,operation,input)=>{if(['chat.send','chat.retry','sources.models','sources.test','mcp.call','schedules.run'].includes(operation)){globalThis.__keychainExternalOperations.push(operation);throw new Error('External operation disabled');}return original(event,operation,input);});
  });
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  assert.equal((await app.evaluate(()=>globalThis.__keychainFixture)).configureCalls,0);
  await page.getByRole('tab',{name:'安全与权限',exact:true}).click();await page.getByText('访问列表已包含 WorkDay。如仍弹窗，可重新配置。',{exact:true}).waitFor();
  await page.waitForTimeout(700);let state=await app.evaluate(()=>globalThis.__keychainFixture);assert.equal(state.statusCalls,1,'Opening settings must query once without refresh/effect loops');assert.equal(state.configureCalls,0);checks.push('Opening page queries status once and never configures');
  const configure=page.getByRole('button',{name:'自动配置',exact:true});
  await configure.click();assert.equal(await configure.isDisabled(),true);await page.getByText('已取消配置，可随时重试。',{exact:true}).waitFor();
  await page.waitForTimeout(350);assert.equal((await app.evaluate(()=>globalThis.__keychainFixture)).statusCalls,1,'Cancellation must not be overwritten by background queries');assert.equal(await configure.isEnabled(),true);
  await configure.click();await page.getByText('已更新钥匙串访问设置。',{exact:true}).waitFor();checks.push('Busy blocks duplicate clicks; cancellation remains visible and retry succeeds');
  await page.getByRole('button',{name:'打开钥匙串',exact:true}).click();assert.equal((await app.evaluate(()=>globalThis.__keychainFixture)).openCalls,1);assert.equal((await app.evaluate(()=>globalThis.__keychainFixture)).configureCalls,2);
  await page.getByRole('button',{name:'重新检查',exact:true}).click();await page.getByText('访问列表已包含 WorkDay。如仍弹窗，可重新配置。',{exact:true}).waitFor();assert.equal((await app.evaluate(()=>globalThis.__keychainFixture)).statusCalls,2);checks.push('Open and refresh stay separate from configuration');
  const layouts=[];
  for(const width of [1440,660]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,980),width);await page.waitForFunction(width=>innerWidth===width,width);
   const layout=await page.locator('[aria-label="钥匙串访问"]').evaluate(element=>{const bounds=element.getBoundingClientRect();return {width:innerWidth,left:bounds.left,right:bounds.right,overflow:document.documentElement.scrollWidth>innerWidth+1,buttons:[...element.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right};})};});
   assert.equal(layout.overflow,false);assert.ok(layout.buttons.every(button=>button.left>=layout.left&&button.right<=layout.right));layouts.push(layout);
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
   await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.mouse.move(0,0);await page.keyboard.press('Escape');await page.locator('[role="tooltip"]').waitFor({state:'hidden'});await page.waitForTimeout(250);
   await page.screenshot({path:path.join(output,`${width}.png`),animations:'disabled'});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  }
  assert.deepEqual(errors,[]);state=await app.evaluate(()=>globalThis.__keychainFixture);assert.equal(state.credentialCalls,0);assert.equal(state.nativeCalls,0);assert.deepEqual(await app.evaluate(()=>globalThis.__keychainExternalOperations),[]);
  const result={passed:true,checks,layouts,fixture:state,realKeychainCalls:0,realCredentialCalls:0,modelRequests:0,personalData:false,dataDirectory:data,executable:await app.evaluate(()=>process.execPath)};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
 finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
