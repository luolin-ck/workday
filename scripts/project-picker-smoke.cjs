const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
const {selectDropdown,storedDropdownValue}=require('./model-picker-fixture.cjs');

async function main(){
 const root=path.resolve(__dirname,'..'),data=await fs.mkdtemp(path.join(os.tmpdir(),'workday-project-picker-'));
 const output=path.join(root,'output/playwright/project-picker');await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
 const checks=[],geometry=[],errors=[];let app,page;
 const picker=()=>page.locator('.composer-project').getByRole('combobox',{name:'所属项目',exact:true});
 async function call(op,input={}){const result=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
 async function layout(){return picker().evaluate(el=>{
  const style=getComputedStyle(el),box=el.getBoundingClientRect(),row=el.closest('.composer-project'),calendar=row.querySelector('.composer-calendar').getBoundingClientRect();
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;
  return {viewport:innerWidth,label:el.value,width:box.width,expected:context.measureText(el.value).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth),right:box.right,calendarLeft:calendar.left,calendarRight:calendar.right,rowRight:row.getBoundingClientRect().right,overflow:document.documentElement.scrollWidth>innerWidth+1};
 });}
 try{
  app=await launchWithWeatherFixture(_electron,{executablePath:require('electron'),args:[root],env,timeout:30000},{mockHolidays:true});
  page=await app.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow,ipcMain})=>{const window=BrowserWindow.getAllWindows()[0];window.hide();window.webContents.setBackgroundThrottling(false);const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',(event,op,input)=>{if(op==='context.attachments.pick')return new Promise(resolve=>{globalThis.__projectPickerRelease=()=>resolve({ok:true,value:[]});});if(['chat.send','chat.retry','sources.test','sources.models','mcp.discover','mcp.call','schedules.run'].includes(op))throw Error('External request blocked in project picker fixture');return original(event,op,input);});});
  const names=['甲','用于检查项目名称自适应和窄窗口省略的合成项目'.repeat(3),'合成已归档项目'];const projects=[];
  for(let i=0;i<names.length;i++){const directory=path.join(data,'project-'+i);await fs.mkdir(directory);projects.push(await call('projects.save',{name:names[i],description:'',directory}));}
  await call('projects.archive',{id:projects[2].id,expectedVersion:projects[2].version,archived:true});
  const source=await call('sources.save',{name:'合成模型源',baseUrl:'https://fixture.invalid/v1',models:[{id:'synthetic',name:'合成模型',supportsTools:false}]});await call('settings.defaultModel',{model:{sourceId:source.id,modelId:'synthetic'}});
  await picker().waitFor();assert.equal(await picker().evaluate(el=>el.tagName),'INPUT');assert.equal(await picker().inputValue(),'不在项目中');assert.ok(await picker().evaluate(el=>el.closest('.dropdown-content')));
  await picker().click();assert.equal(await page.getByRole('option',{name:names[2],exact:true}).count(),0);await page.getByRole('option',{name:'不在项目中',exact:true}).click();assert.equal(await storedDropdownValue(picker()),'');
  checks.push('Home uses the shared dropdown; explicit unassigned selection and archived filtering are preserved');
  for(const width of [1500,660]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,980),width);await page.waitForFunction(width=>innerWidth===width,width);
   await selectDropdown(picker(),projects[0].id);const short=await layout();geometry.push(short);assert.ok(Math.abs(short.width-short.expected)<3,JSON.stringify(short));assert.equal(short.overflow,false);
   await selectDropdown(picker(),projects[1].id);const long=await layout();geometry.push(long);assert.ok(long.width>short.width);assert.ok(long.right<=long.calendarLeft+1,JSON.stringify(long));assert.ok(long.calendarRight<=long.rowRight+1);assert.equal(long.overflow,false);
   await picker().click();const menu=page.locator('.dropdown-menu:visible');const style=await menu.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {left:r.left,right:r.right,radius:s.borderRadius,shadow:s.boxShadow};});assert.ok(style.left>=0&&style.right<=width+1,JSON.stringify(style));assert.ok(parseFloat(style.radius)>0);assert.notEqual(style.shadow,'none');await page.keyboard.press('Escape');
   await selectDropdown(picker(),projects[0].id);assert.ok(Math.abs((await layout()).width-short.width)<2);
  }
  checks.push('At 1500/660px the trigger follows short content, shrinks back and truncates long names without displacing the date; menu stays inside the viewport');
  await picker().focus();await page.keyboard.press('ArrowDown');await page.getByRole('listbox').waitFor();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await storedDropdownValue(picker()),projects[1].id);await picker().click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('listbox').count(),0);
  checks.push('Arrow keys and Enter select a project; Escape closes the shared menu');
  await page.getByRole('button',{name:'添加上下文',exact:true}).click();await page.getByRole('menuitem',{name:'上传附件',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.composer-project [role="combobox"]').disabled);assert.equal(await picker().isDisabled(),true);await app.evaluate(()=>globalThis.__projectPickerRelease());await picker().waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.composer-project [role="combobox"]').disabled);
  checks.push('The project dropdown is disabled during an in-progress upload and re-enables afterwards without reading an attachment');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  await call('tasks.save',{title:'合成项目选择器待办',notes:'',date,dueDate:null,projectId:projects[0].id,completed:false});const edit=page.getByRole('button',{name:'编辑与改期 合成项目选择器待办',exact:true});await edit.focus();await edit.press('Enter');const dialog=page.getByRole('dialog',{name:'编辑待办',exact:true}),form=dialog.getByRole('combobox',{name:'所属项目',exact:true});await form.waitFor();assert.ok(await form.evaluate(el=>el.closest('.dropdown-fill')));assert.ok((await form.boundingBox()).width>200);await selectDropdown(form,'');assert.equal(await storedDropdownValue(form),'');
  checks.push('The shared project dropdown still fills its form field and maps unassigned back to an empty stored value');
  await selectDropdown(form,projects[0].id);await call('projects.archive',{id:projects[0].id,expectedVersion:projects[0].version,archived:true});await page.waitForFunction(()=>document.querySelector('[role="dialog"] [aria-label="所属项目"]').value==='甲（已归档）');await form.click();const archived=page.getByRole('option',{name:'甲（已归档）',exact:true});assert.equal(await archived.evaluate(el=>el.hasAttribute('data-combobox-disabled')),true);await page.keyboard.press('Escape');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'知识库',exact:true}).click();const toolbar=page.locator('.toolbar .project-picker');await toolbar.waitFor();assert.ok((await toolbar.boundingBox()).width<=231);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);const filter=toolbar.getByRole('combobox',{name:'所属项目',exact:true});await filter.click();assert.equal(await page.getByRole('option',{name:'甲（已归档）',exact:true}).evaluate(el=>el.hasAttribute('data-combobox-disabled')),false);await page.keyboard.press('Escape');await selectDropdown(filter,projects[0].id);assert.equal(await storedDropdownValue(filter),projects[0].id);
  checks.push('The knowledge toolbar keeps its existing compact width after the shared component migration');
  checks.push('An already selected archived project stays visible and disabled in forms; includeArchived filters still allow selecting it');
  assert.deepEqual(errors,[]);const result={passed:true,checks,geometry,realElectron:true,personalData:false,realModel:false,nativeAttachmentExecuted:false,visualScreenshotInspected:false,packageUpdated:false};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:checks.length,output}));
 }catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,geometry},null,2));throw error;}
 finally{if(app)await app.close();await fs.rm(data,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
