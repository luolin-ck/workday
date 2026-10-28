// Isolated Electron UI acceptance for project group disclosure and borderless sidebar controls.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'stage':'source';
 const output=path.resolve(process.env.WORKDAY_SMOKE_OUTPUT||path.join(root,'output/playwright/sidebar-toggle-'+kind));
 const data=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-sidebar-toggle-')));
 await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const startedAt=new Date().toISOString(),checks=[],frames=[],errors=[],actionLayouts=[];let app,page;
 const call=async(op,input={})=>{const r=await page.evaluate(({op,input})=>window.workday.call(op,input),{op,input});assert.equal(r.ok,true,JSON.stringify(r));return r.value};
 const until=async(test,label)=>{const end=Date.now()+5000;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+label)};
 const frame=async (name,preservePointer=false)=>{if(!preservePointer)await page.mouse.move(0,0);const bytes=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await fs.writeFile(path.join(output,name),Buffer.from(bytes,'base64'));frames.push(name)};
 const group=id=>page.locator('.project-group[data-project-id="'+(id??'none')+'"]');
 const select=id=>group(id).locator('.project-select');
 const list=id=>group(id).locator('.conversation-list');
 const chatButton=title=>page.locator('.conversation-list').getByRole('button',{name:title,exact:true});
 const styles=loc=>loc.evaluate(e=>{const s=getComputedStyle(e);return{border:s.borderTopWidth,outline:s.outlineStyle,shadow:s.boxShadow,background:s.backgroundColor,weight:s.fontWeight,focusVisible:e.matches(':focus-visible')}});
 try{
  const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='source'?[root]:[],env,timeout:30000},{mockHolidays:true,keychain:true});
  page=await app.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await app.evaluate(({app,BrowserWindow,ipcMain},{data})=>{
   if(app.getPath('userData')!==data)throw Error('Isolation mismatch');const w=BrowserWindow.getAllWindows()[0];w.setSize(1400,950);w.showInactive();w.webContents.setBackgroundThrottling(false);
   globalThis.__sidebarFixture={blocked:[],calls:[]};const original=ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');ipcMain.handle('workday:call',async(event,op,input)=>{if(['chat.send','chat.retry','sources.models','sources.test','schedules.run','mcp.discover','mcp.call','git.connect','git.repositories','git.import','projects.download','skills.approveRun','grants.save'].includes(op)){globalThis.__sidebarFixture.blocked.push(op);throw Error('External operation blocked')}globalThis.__sidebarFixture.calls.push(op);return original(event,op,input)});
  },{data});
  await page.route(/^https?:\/\//,route=>{errors.push('Unexpected renderer network');return route.abort()});
  await page.getByRole('navigation',{name:'全局导航'}).waitFor();
  const folder=path.join(data,'fixture-project');await fs.mkdir(folder);
  const project=await call('projects.save',{name:'侧栏验收项目',description:'',directory:folder});
  const chat=await call('conversations.create',{title:'无项目测试对话',projectId:null,date:null,model:null});
  const projectChat=await call('conversations.create',{title:'项目内测试对话：较长标题仍保持省略号操作按钮对齐',projectId:project.id,date:null,model:null});
  await page.getByRole('button',{name:'项目',exact:true}).click();await chatButton(chat.title).click();
  const input=page.getByRole('textbox',{name:'消息输入',exact:true});await input.fill('未发送草稿保留哨兵');
  await select(null).click();
  assert.equal(await select(null).getAttribute('aria-expanded'),'false','BUSINESS RED: clicking the group name must collapse its conversations');
  await list(null).waitFor({state:'hidden'});assert.equal(await input.inputValue(),'未发送草稿保留哨兵','collapse must not replace the current chat or draft');
  await select(null).click();await list(null).waitFor();assert.equal(await chatButton(chat.title).getAttribute('aria-current'),'page');
  checks.push('projectless full-row click toggles disclosure and preserves active chat plus unsent draft');
  for(const id of [null,project.id]){
   const button=select(id);assert.equal(await button.getAttribute('aria-pressed'),null);assert.equal(await button.getAttribute('aria-current'),null);assert.ok(!(await button.getAttribute('class')).split(/\s+/).includes('selected'));
   await button.hover();const heading=await styles(group(id).locator('.project-group-heading'));assert.equal(heading.background,'rgba(0, 0, 0, 0)','group heading has no hover highlight');
   await button.locator('.project-toggle').click();assert.equal(await button.getAttribute('aria-expanded'),'false');await list(id).waitFor({state:'hidden'});
   await button.press('Enter');assert.equal(await button.getAttribute('aria-expanded'),'true');await list(id).waitFor();
   await button.press('Space');assert.equal(await button.getAttribute('aria-expanded'),'false');await list(id).waitFor({state:'hidden'});
   await button.press('Space');await list(id).waitFor();
  }
  checks.push('normal/projectless rows expose disclosure only; arrow, Enter and Space toggle without selected or hover group highlight');
  await chatButton(projectChat.title).click();assert.equal(await chatButton(projectChat.title).getAttribute('aria-current'),'page');await input.fill('项目草稿保留哨兵');
  await select(null).click();await list(null).waitFor({state:'hidden'});assert.equal(await input.inputValue(),'项目草稿保留哨兵');assert.equal(await chatButton(projectChat.title).getAttribute('aria-current'),'page');await select(null).click();await list(null).waitFor();
  await chatButton(chat.title).click();await until(async()=>await chatButton(chat.title).getAttribute('aria-current')==='page'&&await input.inputValue()==='未发送草稿保留哨兵','projectless chat selection restores its draft');await chatButton(projectChat.title).click();await until(async()=>await chatButton(projectChat.title).getAttribute('aria-current')==='page'&&await input.inputValue()==='项目草稿保留哨兵','project chat selection restores its draft');
  checks.push('clicking another group never navigates away; chat selection still restores each unsent draft');
  for(const item of [{button:group(project.id).getByRole('button',{name:'项目操作 '+project.name,exact:true}),entry:'编辑项目'},{button:group(project.id).getByRole('button',{name:'聊天操作 '+projectChat.title,exact:true}),entry:'改名'}]){
   await item.button.click();await page.getByRole('menuitem',{name:item.entry,exact:true}).waitFor();assert.equal(await select(project.id).getAttribute('aria-expanded'),'true');assert.equal(await input.inputValue(),'项目草稿保留哨兵');await page.keyboard.press('Escape');
  }
  checks.push('project/chat more menus open without collapsing or navigating the current conversation');
  const verifyActions=async()=>{
   const layout=await group(project.id).evaluate(el=>{
    const measure=button=>{const r=button.getBoundingClientRect(),icon=button.querySelector('svg'),ir=icon.getBoundingClientRect();return{center:r.x+r.width/2,right:r.right,width:r.width,height:r.height,iconWidth:ir.width,iconHeight:ir.height,color:getComputedStyle(button).color,iconColor:getComputedStyle(icon).color}};
    const project=el.querySelector('.project-group-heading>.project-more'),chat=el.querySelector('.conversation-row>.project-more'),sidebar=el.closest('.project-page'),add=sidebar.querySelector('[aria-label="创建项目"]');
    const probe=document.createElement('span');probe.style.cssText='color:var(--faint-text);width:var(--size-actionSmall);height:var(--size-actionSmall);display:block';el.append(probe);const expectedColor=getComputedStyle(probe).color,expectedTarget=probe.getBoundingClientRect().width;probe.style.width='var(--icon-sidebar)';const expectedIcon=probe.getBoundingClientRect().width;probe.remove();
    const iconRect=e=>{const r=e.getBoundingClientRect();return{left:r.left,width:r.width,height:r.height}};
    const newChatIcon=iconRect(sidebar.querySelector('.project-new-chat>svg')),headingLeft=sidebar.querySelector('.project-sidebar-heading h2').getBoundingClientRect().left,leadingIcons=[...sidebar.querySelectorAll('.project-select>svg')].map(iconRect);
    return{viewport:innerWidth,project:measure(project),chat:measure(chat),add:measure(add),newChatIcon,headingLeft,leadingIcons,expectedColor,expectedTarget,expectedIcon};
   });
   assert.ok(Math.abs(layout.project.center-layout.chat.center)<0.5,'Project and chat action icons align on the same vertical axis');
   for(const action of [layout.project,layout.chat]){assert.equal(action.iconWidth,layout.expectedIcon);assert.equal(action.iconHeight,layout.expectedIcon);assert.equal(action.color,layout.expectedColor);assert.equal(action.iconColor,layout.expectedColor);assert.equal(action.width,layout.expectedTarget,'Smaller icon retains its themed pointer target');assert.equal(action.height,layout.expectedTarget);}
   assert.ok(Math.abs(layout.add.center-layout.project.center)<0.5,'Add and more controls align on the same right-hand axis');
   assert.ok(Math.abs(layout.newChatIcon.left-layout.headingLeft)<0.5,'New chat icon and section heading share the left edge');
   assert.equal(layout.add.width,layout.expectedTarget);assert.equal(layout.add.height,layout.expectedTarget);assert.equal(layout.add.iconWidth,layout.expectedIcon);assert.equal(layout.add.iconHeight,layout.expectedIcon);
   for(const icon of [layout.newChatIcon,...layout.leadingIcons]){assert.equal(icon.width,layout.expectedIcon);assert.equal(icon.height,layout.expectedIcon);}
   actionLayouts.push(layout);
  };
  await verifyActions();await group(project.id).locator('.project-group-heading>.project-more').focus();await group(project.id).locator('.conversation-row').hover();
  await frame('sidebar-actions-aligned.png',true);
  checks.push('New chat and heading share a left edge; add and more actions share a right-hand axis; all main sidebar icons share one size token');

  const controls=[select(null),select(project.id),chatButton(projectChat.title),page.getByRole('button',{name:'新建聊天',exact:true}),page.getByRole('button',{name:'创建项目',exact:true})];
  for(const control of controls){const s=await styles(control);assert.equal(s.border,'0px');assert.equal(s.outline,'none');assert.equal(s.shadow,'none');}
  await chatButton(projectChat.title).click();let s=await styles(chatButton(projectChat.title));assert.equal(s.outline,'none');assert.equal(s.shadow,'none');await frame('sidebar-mouse.png');
  // Tab from the preceding sidebar control sets real keyboard modality, unlike programmatic focus after a click.
  await page.mouse.move(0,0);await page.getByRole('button',{name:'创建项目',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await select(null).evaluate(e=>document.activeElement===e),true);
  await until(async()=>(await styles(select(null))).background!=='rgba(0, 0, 0, 0)','keyboard background transition starts');s=await styles(select(null));assert.equal(s.focusVisible,true);assert.equal(s.outline,'none');assert.equal(s.shadow,'none');assert.notEqual(s.background,'rgba(0, 0, 0, 0)');await frame('sidebar-keyboard.png');
  checks.push('sidebar buttons have no borders/outlines/shadows; keyboard focus uses a light background instead');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,900));await until(()=>page.evaluate(()=>innerWidth===760),'narrow width');await frame('sidebar-narrow.png');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await verifyActions();checks.push('narrow viewport remains within horizontal bounds and action icons stay aligned');
  await page.evaluate(()=>{const s=document.documentElement.style;s.setProperty('--space-4','6px');s.setProperty('--space-8','10px');s.setProperty('--icon-sidebar','16px');s.setProperty('--size-actionSmall','24px')});await verifyActions();checks.push('Shared alignment survives themed spacing, icon size and action target changes');
  const isolation=await app.evaluate(()=>({blocked:globalThis.__sidebarFixture.blocked,nativeCalls:globalThis.__keychainFixture.nativeCalls,credentialCalls:globalThis.__keychainFixture.credentialCalls}));assert.deepEqual(isolation.blocked,[]);assert.equal(isolation.nativeCalls,0);assert.equal(isolation.credentialCalls,0);assert.deepEqual(errors,[]);
  const runtime=await app.evaluate(({app},expected)=>({app:app.getAppPath(),executable:app.getPath('exe'),dataDirectoryVerified:app.getPath('userData')===expected}),data);assert.ok(runtime.dataDirectoryVerified);
  const source={};for(const file of ['src/renderer/projects.tsx','src/renderer/style.css','src/renderer/theme.ts'])source[file]=createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
  const result={passed:true,kind,startedAt,completedAt:new Date().toISOString(),runtime,checks,frames,actionLayouts,source,scriptSha256:createHash('sha256').update(await fs.readFile(__filename)).digest('hex'),personalData:false,realModel:false,realCredentials:false,actualMcpCalls:0,isolation};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
 }catch(e){if(page)await frame('failure.png').catch(()=>{});await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),checks,frames,errors},null,2));throw e}
 finally{if(app)await app.close().catch(()=>{});await fs.rm(data,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
