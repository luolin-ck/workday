// Visual acceptance of the compact model setup hint; all data is synthetic and isolated.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
const {selectModel}=require('./model-picker-fixture.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),baseline=process.env.WORKDAY_HINT_BASELINE==='1';
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wd-model-hint-'))),output=path.join(root,'output/playwright',baseline?'model-hint-before':'model-hint-stage');
 await fs.mkdir(output,{recursive:true});let app,page,result;const checks=[],errors=[],layouts=[];
 const call=async(op,input={})=>{const r=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
 const input=()=>page.getByRole('textbox',{name:'消息输入',exact:true}),hint=()=>page.locator('.composer-model-hint');
 const nav=label=>page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name:label,exact:true});
 const frame=async name=>{await page.mouse.move(0,0);await page.screenshot({path:path.join(output,name),timeout:10000});};
 const record=s=>{checks.push(s);console.log(s);};
 async function geometry(label){
  const g=await hint().evaluate(h=>{const span=h.querySelector('span'),button=h.querySelector('button'),textarea=h.parentElement.querySelector('textarea'),surface=h.parentElement.querySelector('.composer-input');const r=h.getBoundingClientRect(),s=span.getBoundingClientRect(),b=button.getBoundingClientRect(),t=textarea.getBoundingClientRect(),c=surface.getBoundingClientRect(),hs=getComputedStyle(h),bs=getComputedStyle(button),ts=getComputedStyle(textarea);return {height:r.height,width:r.width,background:hs.backgroundColor,border:hs.borderTopWidth,fontSize:hs.fontSize,color:hs.color,muted:getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),buttonBackground:bs.backgroundColor,buttonBorder:bs.borderTopWidth,buttonShadow:bs.boxShadow,textX:s.x,inputTextX:t.x+parseFloat(ts.paddingLeft)+parseFloat(ts.borderLeftWidth),sameLine:Math.abs(s.y+s.height/2-b.y-b.height/2)<1,buttonContained:b.left>=r.left-1&&b.right<=r.right+1,overflow:h.scrollWidth>h.clientWidth+1,gapBelow:c.y-r.bottom};});
  assert.equal(g.background,'rgba(0, 0, 0, 0)');assert.equal(g.border,'0px');assert.equal(g.buttonBackground,'rgba(0, 0, 0, 0)');assert.equal(g.buttonBorder,'0px');assert.equal(g.buttonShadow,'none');assert.ok(Math.abs(g.textX-g.inputTextX)<=1,JSON.stringify(g));assert.ok(g.buttonContained&&!g.overflow,JSON.stringify(g));assert.ok(g.gapBelow>=4&&g.gapBelow<=12,JSON.stringify(g));
  if(label==='wide')assert.ok(g.sameLine&&g.height<=32,JSON.stringify(g));
  layouts.push({label,...g});return g;
 }
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:process.env.WORKDAY_ELECTRON_EXECUTABLE?[]:[root],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({BrowserWindow,ipcMain})=>{const w=BrowserWindow.getAllWindows()[0];w.showInactive();w.setSize(1400,950);w.webContents.setBackgroundThrottling(false);const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',(e,op,input)=>{if(['chat.send','chat.retry','chat.continue','sources.test','sources.models','schedules.run'].includes(op))throw Error('External operations disabled in hint fixture');return original(e,op,input);});});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  assert.equal(await hint().count(),0);assert.equal(await page.getByRole('button',{name:'配置模型源',exact:true}).count(),1);record('Home retains its single existing configuration action');
  const chat=await call('conversations.create',{title:'提示样式验收',projectId:null,date:null,model:null});
  await nav('项目').click();await page.getByRole('button',{name:'提示样式验收',exact:true}).click();await input().fill('项目草稿保留');
  if(baseline){const g=await page.locator('.composer>.notice').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {height:r.height,background:s.backgroundColor,border:s.borderTopWidth,text:el.textContent};});layouts.push({label:'before',...g});await frame('before.png');result={passed:true,baseline:true,checks,layouts,errors};return;}
  await hint().waitFor();assert.equal(await page.getByText('选择模型后即可开始对话',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);await geometry('wide');await frame('wide.png');record('Missing model uses one compact transparent aligned row; sending remains disabled');
  await hint().getByRole('button',{name:'配置模型源',exact:true}).click();await page.getByRole('heading',{name:'设置',exact:true}).waitFor();await nav('项目').click();assert.equal(await input().inputValue(),'项目草稿保留');await hint().waitFor();record('Configuration action opens settings and returning preserves the draft');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,950));await page.waitForFunction(()=>innerWidth===760);await geometry('narrow');await frame('narrow.png');record('Narrow window keeps the hint and unbroken action inside the composer');
  await hint().getByRole('button',{name:'配置模型源',exact:true}).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await hint().getByRole('button',{name:'配置模型源',exact:true}).evaluate(el=>el.matches(':focus-visible')&&parseFloat(getComputedStyle(el).outlineWidth)>0),true);record('Keyboard focus remains visible on the configuration action');
  await nav('设置').click();await page.getByRole('tab',{name:'主题',exact:true}).click();await page.getByRole('button',{name:'蓝白',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='blue');await nav('项目').click();await geometry('blue');await frame('blue.png');record('Alternate theme uses existing tokens with the same compact layout');
  const file=path.join(data,'参考.txt');await fs.writeFile(file,'Synthetic attachment.');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:/^添加上下文/}).click();await page.getByRole('menuitem',{name:'上传附件',exact:true}).click();await page.getByRole('button',{name:'移除附件 参考.txt',exact:true}).waitFor();assert.equal(await page.locator('.composer-input>.composer-attachment-area').count(),1);await geometry('attachment');assert.equal(await input().inputValue(),'项目草稿保留');await frame('attachment.png');record('Attachment area remains inside the input surface without changing the hint alignment');
  const source=await call('sources.save',{name:'合成模型源',baseUrl:'https://model-hint.invalid/v1',models:[{id:'fixture-model',name:'Fixture',supportsTools:false}]});await selectModel(page.getByRole('combobox',{name:'选择模型与模型源',exact:true}),JSON.stringify([source.id,'fixture-model']));await hint().waitFor({state:'detached'});assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);assert.equal(await input().inputValue(),'项目草稿保留');record('Selecting a valid synthetic model removes the hint and enables the existing send control');
  await nav('Home').click();assert.equal(await hint().count(),0);assert.deepEqual(errors,[]);result={passed:true,checks,layouts,errors,syntheticChatId:chat.id};
 }catch(e){result={passed:false,checks,layouts,errors,error:String(e)};throw e;}
 finally{if(app)await app.close();await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result??{passed:false,checks,layouts,errors},null,2));await fs.rm(data,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
