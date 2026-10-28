const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { setFixtureTheme } = require('./appearance-fixture.cjs');
async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-git-ui-'));
  const output = path.join(root,'output/playwright',process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'git-links-stage' : 'git-links-source');
  await fs.mkdir(output,{recursive:true});
  let app;
  const errors=[],checks=[];
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000 }, {mockHolidays:true});
    const page = await app.firstWindow(); page.setDefaultTimeout(5000); page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.hide(); window.webContents.setBackgroundThrottling(false);
      const original=ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      const account={provider:'github',connectionId:'fixture-connection',accountId:123,login:'fixture-user',credentialConfigured:true};
      const repo=id=>({provider:'github',connectionId:account.connectionId,repositoryId:id,owner:'fixture-owner',name:id===1?'first-repo':'second-repo',defaultBranch:'main',private:true,description:'合成仓库'});
      const source={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic UI model',enabled:true,models:[{id:'fixture',name:'fixture',supportsTools:false}],configVersion:1,version:1,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z',baseUrl:'https://never-contact.invalid',credentialConfigured:false,testedAt:null,testStatus:null};
      const model={sourceId:source.id,modelId:'fixture'};
      const repositoryText='# Synthetic README\nExplicit selected repository text.\n'+'x'.repeat(31000);
      globalThis.__gitUI={account:null,projects:[],knowledge:[],conversations:[],sent:[],calls:[],previewDelay:0,importDelay:0};
      ipcMain.handle('workday:call',async(event,op,input)=>{
        const fixture=globalThis.__gitUI;
        if(op==='state.get') {const result=await original(event,op,input);return {...result,value:{...result.value,gitAccount:fixture.account,projects:fixture.projects,knowledge:fixture.knowledge,conversations:fixture.conversations,sources:[source],defaultModel:model}};}
        if(op.startsWith('git.')||op.startsWith('projects.')||op.startsWith('conversations.')||op==='chat.send')fixture.calls.push({op,...(op==='git.connect'?{}:{input})});
        const ok=value=>({ok:true,value});
        if(op==='git.connect') {if(input.secret!=='synthetic-ui-token')throw new Error('Synthetic token expected');await new Promise(r=>setTimeout(r,350));fixture.account=account;return ok(account);}
        if(op==='git.openSettings')return ok(true);
        if(op==='git.disconnect'){fixture.account=null;return ok(true);}
        if(op==='git.repositories')return ok({items:[repo(input.page)],hasMore:input.page===1});
        if(op==='projects.pickDirectory')return ok({directory:'/synthetic/local-folder',name:'local-folder'});
        if(op==='projects.save'){const old=fixture.projects.find(p=>p.id===input.id);const saved={...old,...input,id:old?.id||`project-${fixture.projects.length+1}`,version:(old?.version||0)+1,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z',archived:false};fixture.projects=old?fixture.projects.map(p=>p.id===saved.id?saved:p):fixture.projects.concat(saved);return ok(saved);}
        if(op==='git.preview'){await new Promise(r=>setTimeout(r,fixture.previewDelay));return ok({token:'fixture-preview',repository:'fixture-owner/second-repo',commit:'a'.repeat(40),paths:input.paths,content:repositoryText});}
        if(op==='git.import'){await new Promise(r=>setTimeout(r,fixture.importDelay));const knowledge={id:`knowledge-${fixture.knowledge.length+1}`,name:'github fixture-owner/second-repo',content:repositoryText,projectId:fixture.projects.find(p=>p.repository)?.id,version:1,removed:false,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'};fixture.knowledge.push(knowledge);return ok(knowledge);}
        if(op==='conversations.create'){const value={...input,id:'22222222-2222-4222-8222-222222222222',title:'Synthetic conversation',model,context:{date:null,taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[]},version:1,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z',activeRequestId:null,archived:false};fixture.conversations.push(value);return ok(value);}
        if(op==='conversations.history')return ok([]);
        if(op==='conversations.context'){const current=fixture.conversations.find(value=>value.id===input.id);current.context=input.context;current.version++;return ok(current);}
        if(op==='chat.send'){fixture.sent.push(input);return ok({requestId:'synthetic-request',userMessageId:'synthetic-user'});}
        if(['sources.models','sources.test','schedules.run','schedules.toggle'].includes(op))throw new Error('External operation blocked in Git UI fixture');
        return original(event,op,input);
      });
    });
    await page.reload();
    const nav=name=>page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name,exact:true});
    const dialog=name=>page.getByRole('dialog',{name,exact:true});
    const close=async name=>{const modal=dialog(name);await modal.getByRole('button',{name:'关闭对话框',exact:true}).click();await modal.waitFor({state:'detached'});};
    await nav('设置').click();
    assert.equal(await page.getByRole('tab',{name:'关联',exact:true}).count(),1,'Settings must expose the account links tab');
    await page.getByRole('tab',{name:'关联',exact:true}).click();
    await page.getByRole('button',{name:'关联账号',exact:true}).waitFor();
    // Unconnected project entry reaches the matching settings tab.
    await nav('项目').click();await page.getByRole('button',{name:'创建项目',exact:true}).click();await page.getByRole('menuitem',{name:'GitHub 仓库',exact:true}).click();
    await dialog('选择 GitHub 仓库').getByRole('button',{name:'前往关联设置',exact:true}).click();
    await page.getByRole('tab',{name:'关联',exact:true}).waitFor();
    assert.equal(await page.getByRole('tab',{name:'关联',exact:true}).getAttribute('aria-selected'),'true');
    await page.getByRole('button',{name:'关联账号',exact:true}).click();
    await dialog('关联 GitHub').getByLabel('Personal Access Token',{exact:true}).fill('synthetic-ui-token');
    await dialog('关联 GitHub').getByRole('button',{name:'在 GitHub 创建令牌',exact:true}).click();
    await dialog('关联 GitHub').getByRole('button',{name:'关联',exact:true}).click();
    assert.equal(await page.locator('input[type="password"]').inputValue(),'','Credential input clears immediately, before IPC completes');
    await page.getByText('@fixture-user · 已关联',{exact:true}).waitFor();
    assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('synthetic-ui-token'));
    checks.push('unconnected entry, account connect, clear secret, official settings operation');
    // Existing local folder flow remains; attaching a repository preserves its directory.
    await nav('项目').click();await page.getByRole('button',{name:'创建项目',exact:true}).click();await page.getByRole('menuitem',{name:'本地文件夹',exact:true}).click();
    await dialog('创建项目').getByRole('button',{name:'保存',exact:true}).click();await dialog('创建项目').waitFor({state:'detached'});
    await page.getByRole('button',{name:'项目操作 local-folder',exact:true}).click();await page.getByRole('menuitem',{name:'编辑项目',exact:true}).click();
    await dialog('编辑项目').getByRole('button',{name:'选择仓库',exact:true}).click();
    await dialog('选择 GitHub 仓库').getByText('fixture-owner/first-repo',{exact:true}).waitFor();
    await dialog('选择 GitHub 仓库').getByRole('button',{name:'加载更多',exact:true}).click();
    await dialog('选择 GitHub 仓库').getByLabel('搜索已加载仓库',{exact:true}).fill('second');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.screenshot({path:path.join(output,'repository-picker.png'),animations:'disabled'});
    assert.equal(await dialog('选择 GitHub 仓库').locator('.repository-card').count(),1);
    await dialog('选择 GitHub 仓库').getByRole('button').filter({hasText:'fixture-owner/second-repo'}).click();
    await dialog('选择 GitHub 仓库').waitFor({state:'detached'});
    assert.equal(await dialog('编辑项目').getByLabel('项目文件夹',{exact:true}).inputValue(),'/synthetic/local-folder');
    await dialog('编辑项目').getByRole('button',{name:'保存',exact:true}).click();await dialog('编辑项目').waitFor({state:'detached'});
    await page.getByRole('button',{name:'项目操作 local-folder',exact:true}).click();await page.getByRole('menuitem',{name:'编辑项目',exact:true}).click();
    await dialog('编辑项目').getByLabel('简介',{exact:true}).fill('只编辑简介');await dialog('编辑项目').getByRole('button',{name:'保存',exact:true}).click();await dialog('编辑项目').waitFor({state:'detached'});
    assert.equal(await app.evaluate(()=>Object.hasOwn(globalThis.__gitUI.calls.filter(call=>call.op==='projects.save').at(-1).input,'repository')),false,'Unchanged repo must be omitted to preserve offline local edits');
    // Git-only project is separate from the original local project.
    await page.getByRole('button',{name:'创建项目',exact:true}).click();await page.getByRole('menuitem',{name:'GitHub 仓库',exact:true}).click();
    await dialog('选择 GitHub 仓库').getByRole('button').filter({hasText:'fixture-owner/first-repo'}).click();
    await dialog('选择 GitHub 仓库').waitFor({state:'detached'});
    await dialog('创建项目').getByRole('button',{name:'保存',exact:true}).click();await dialog('创建项目').waitFor({state:'detached'});
    const projects=await app.evaluate(()=>globalThis.__gitUI.projects);
    assert.equal(projects[0].directory,'/synthetic/local-folder');assert.equal(projects[0].repository.name,'second-repo');assert.equal(projects[1].directory,null);assert.equal(projects[1].repository.name,'first-repo');
    checks.push('local create, pagination/search, add repo without dropping folder, git-only create');
    // Back to the first project, explicitly preview and add actual text to the draft selection.
    await page.getByRole('button',{name:'local-folder',exact:true}).click();
    await page.getByRole('button',{name:/^添加上下文/}).click();
    await dialog('选择本次对话上下文').getByRole('button',{name:'从仓库添加',exact:true}).click();
    await dialog('从仓库添加上下文').getByRole('button',{name:'读取并预览',exact:true}).click();
    await dialog('从仓库添加上下文').getByLabel('仓库实际文本预览',{exact:true}).waitFor();
    assert.match(await dialog('从仓库添加上下文').getByLabel('仓库实际文本预览',{exact:true}).innerText(),/Explicit selected repository text/);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.screenshot({path:path.join(output,'repository-preview.png'),animations:'disabled'});
    await dialog('从仓库添加上下文').getByRole('button',{name:'添加到本次上下文',exact:true}).click();
    await dialog('从仓库添加上下文').waitFor({state:'detached'});
    assert.equal(await dialog('选择本次对话上下文').getByRole('checkbox',{name:/github fixture-owner\/second-repo/}).isChecked(),true);
    assert.match(await dialog('选择本次对话上下文').getByLabel('实际发送片段（可编辑）',{exact:true}).inputValue(),/Explicit selected repository text/);
    await dialog('选择本次对话上下文').getByRole('button',{name:'保存选择',exact:true}).click();await dialog('选择本次对话上下文').waitFor({state:'detached'});
    assert.match(await page.getByRole('button',{name:/^添加上下文/}).getAttribute('aria-label'),/1/);
    checks.push('preview actual file text, import, selected knowledge excerpt');
    await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('Synthetic context request');await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.waitForFunction(()=>true);await page.waitForTimeout(250);
    let sent=await app.evaluate(()=>globalThis.__gitUI.sent);if(sent.length!==1)await fs.writeFile(path.join(output,'context-send-debug.json'),JSON.stringify({body:(await page.locator('body').innerText()).slice(-6000),ops:await app.evaluate(()=>globalThis.__gitUI.calls.map(item=>item.op))},null,2));assert.equal(sent.length,1);assert.deepEqual(sent[0].context.knowledgeRefs,[{id:'knowledge-1',version:1}]);
    await page.getByRole('button',{name:/^添加上下文/}).click();
    const documentCheck=dialog('选择本次对话上下文').getByRole('checkbox',{name:/github fixture-owner\/second-repo/});await documentCheck.uncheck();await documentCheck.check();
    await dialog('选择本次对话上下文').getByRole('button',{name:'保存选择',exact:true}).click();await dialog('选择本次对话上下文').waitFor({state:'detached'});
    await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('Synthetic reselected context');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.waitForTimeout(250);
    sent=await app.evaluate(()=>globalThis.__gitUI.sent);assert.equal(sent.length,2);assert.deepEqual(sent[1].context.knowledgeRefs,[{id:'knowledge-1',version:1}]);
    checks.push('31k text auto-import and manual reselect both send full refs without oversized excerpts');
    // Closing while a preview is pending never imports or reopens a snapshot.
    await app.evaluate(()=>{globalThis.__gitUI.previewDelay=500;});
    await page.getByRole('button',{name:/^添加上下文/}).click();await dialog('选择本次对话上下文').getByRole('button',{name:'从仓库添加',exact:true}).click();
    await dialog('从仓库添加上下文').getByRole('button',{name:'读取并预览',exact:true}).click();await close('从仓库添加上下文');
    await page.waitForTimeout(650);assert.equal(await dialog('从仓库添加上下文').count(),0);
    assert.equal(await app.evaluate(()=>globalThis.__gitUI.knowledge.length),1);
    await close('选择本次对话上下文');
    checks.push('cancel pending preview produces no import or reopened dialog');
    // An externally changed project invalidates an in-flight preview rather than adding it to a new scope.
    await page.getByRole('button',{name:/^添加上下文/}).click();await dialog('选择本次对话上下文').getByRole('button',{name:'从仓库添加',exact:true}).click();
    await dialog('从仓库添加上下文').getByRole('button',{name:'读取并预览',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>{globalThis.__gitUI.projects.find(p=>p.id==='project-1').version++;BrowserWindow.getAllWindows()[0].webContents.send('workday:event',{type:'stateChanged'});});
    await page.waitForTimeout(700);assert.equal(await dialog('从仓库添加上下文').getByLabel('仓库实际文本预览',{exact:true}).count(),0);
    assert.equal(await dialog('从仓库添加上下文').getByRole('button',{name:'添加到本次上下文',exact:true}).count(),0);
    await close('从仓库添加上下文');await close('选择本次对话上下文');
    checks.push('project version changed during preview invalidates result');
    // Theme and width checks use the exact same tabs and card classes.
    for(const theme of ['mono','blue','custom']){
      await setFixtureTheme(page,theme);
      for(const width of [1500,660]){
        await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);await page.waitForFunction(width=>innerWidth===width,width);
        await nav('设置').click();await page.getByRole('tab',{name:'关联',exact:true}).click();
        const geometry=await page.locator('.git-links').evaluate(element=>({width:element.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth+1,tabHeight:document.querySelector('[role="tab"][data-active]').getBoundingClientRect().height}));
        assert.ok(geometry.width>0&&!geometry.overflow,JSON.stringify(geometry));assert.ok(geometry.tabHeight>20);
        await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());await page.screenshot({path:path.join(output,`${theme}-${width}.png`),animations:'disabled'});
        checks.push({theme,width,geometry});
      }
    }
    await page.getByRole('button',{name:'解除关联',exact:true}).click();
    await dialog('解除 GitHub 关联').getByText('停止读取仓库，已导入的本地资料与聊天记录会保留。',{exact:true}).waitFor();
    await dialog('解除 GitHub 关联').getByRole('button',{name:'解除关联',exact:true}).click();await dialog('解除 GitHub 关联').waitFor({state:'detached'});
    await page.getByText('未关联账号',{exact:true}).waitFor();assert.equal(await app.evaluate(()=>globalThis.__gitUI.knowledge.length),1);
    await nav('项目').click();await page.getByRole('button',{name:'local-folder',exact:true}).click();await page.getByRole('button',{name:/^添加上下文/}).click();
    assert.equal(await dialog('选择本次对话上下文').getByRole('button',{name:'从仓库添加',exact:true}).count(),0);
    await close('选择本次对话上下文');await nav('设置').click();await page.getByRole('tab',{name:'关联',exact:true}).click();
    await page.getByRole('button',{name:'关联账号',exact:true}).click();await dialog('关联 GitHub').getByLabel('Personal Access Token',{exact:true}).fill('synthetic-ui-token');await dialog('关联 GitHub').getByRole('button',{name:'关联',exact:true}).click();await page.getByText('@fixture-user · 已关联',{exact:true}).waitFor();
    assert.equal(await dialog('解除 GitHub 关联').count(),0,'Reconnect must not reopen stale disconnect confirmation');
    checks.push('disconnect then reconnect leaves no stale confirmation');
    const calls=await app.evaluate(()=>globalThis.__gitUI.calls);
    assert.equal(calls.filter(call=>call.op==='git.import').length,1);assert.ok(calls.some(call=>call.op==='git.repositories'&&call.input.page===2));assert.deepEqual(errors,[]);
    const result={passed:true,checks,personalData:false,realGitHubRequests:0,realModelRequests:0,calls,dataDirectory:data};
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,checks:checks.length,output}));
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
