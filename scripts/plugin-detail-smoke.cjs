const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const appRoot = process.env.WORKDAY_ICON_APP_ROOT || '/tmp/workday-default-icons-ui-app';
const executablePath = process.env.WORKDAY_ICON_EXECUTABLE || require(path.join(root, 'node_modules/electron'));
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require(path.join(root, 'scripts/electron-fixture-launch.cjs'));
(async () => {
  const output = process.env.WORKDAY_ICON_OUTPUT || path.join(root, 'output/playwright/default-component-icons');
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-default-icons-data-')));
  const packages = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-default-icons-packages-')));
  await fs.mkdir(output, { recursive: true });
  const checks = [], errors = [], frames = [];
  let app;
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, { executablePath, args: process.env.WORKDAY_ICON_EXECUTABLE ? [] : [appRoot], env, timeout: 30000 }, { mockHolidays: true, keychain: {} });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\//, route => route.abort());
    await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.hide(); window.webContents.setBackgroundThrottling(false);
      globalThis.__defaultIconFixture = { package: '', external: [] };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__defaultIconFixture.package] });
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, input) => {
        if (['chat.send','chat.retry','sources.models','sources.test','schedules.run','mcp.discover','mcp.call','mcp.readResource','git.connect','git.repositories','git.import','projects.download','skills.approveRun'].includes(op)) {
          globalThis.__defaultIconFixture.external.push(op); throw Error('External operation blocked');
        }
        return original(event, op, input);
      });
    });
    const call = async (op, input={}) => { const result = await page.evaluate(({op,input}) => window.workday.call(op,input), {op,input}); assert.equal(result.ok,true,JSON.stringify(result)); return result.value; };
    const fixtures = {};
    for (const i of [1,2]) {
      const skill = await call('skills.save', { name: `默认 Skill 图标 ${i}：规范化工作流程与资料整理`, description: '在小尺寸列表中清楚识别技能，长描述保持省略显示。'.repeat(8), content: '# 工作方法\n\n这是隔离界面验证使用的合成内容。' });
      fixtures.Skill ??= skill;
      const mcp = await call('mcp.save', { name: `默认 MCP 图标 ${i}：连接知识与工具服务`, transport: 'http', command: '', args: [], url: `https://fixture.invalid/${'example-'.repeat(24)}${i}` });
      fixtures.MCP ??= mcp;
      const directory=path.join(packages, `package-${i}`); await fs.mkdir(path.join(directory,'skills/fixture'),{recursive:true});
      await fs.writeFile(path.join(directory,'workday-plugin.json'),JSON.stringify({id:`default-icons-fixture-${i}`,name:`默认 Plugin 图标 ${i}：可复用的完整能力包`,version:'1.0.0',description:'组合技能与工具，统一管理可复用能力。'.repeat(8),appVersion:'0.1',skills:['skills/fixture/SKILL.md'],mcp:[]}));
      await fs.writeFile(path.join(directory,'skills/fixture/SKILL.md'),`---\nname: package-skill-${i}\ndescription: 仅用于隔离视觉验证。\n---\n# 包内 Skill\n\n这是合成内容。\n`);
      await app.evaluate((_,directory)=>{globalThis.__defaultIconFixture.package=directory;},directory);
      const preview=await call('plugins.preview'); const plugin=await call('plugins.install',{token:preview.token}); fixtures.Plugin ??= plugin;
    }
    const nav = name => page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name,exact:true});
    const tab = name => page.getByRole('tab',{name,exact:true});
    const frame = async name => { await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive()); await page.mouse.move(1,1); await page.screenshot({path:path.join(output,name),animations:'disabled'}); frames.push(name); };
    for (const [theme,label] of [['mono','黑白'],['blue','蓝白']]) {
      await nav('设置').click(); await tab('主题').click(); await page.getByRole('button',{name:label,exact:true}).click();
      await page.getByRole('button',{name:label,exact:true}).waitFor();
      await nav('插件').click();
      for (const width of [1500,660]) {
        await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width); await page.waitForFunction(width=>innerWidth===width,width);
        for (const type of ['Skill','MCP','Plugin']) {
          await tab(type).click();
          const list=page.getByRole('list',{name:`${type} 列表`,exact:true});
          await list.locator('img.component-icon').first().waitFor();
          await list.locator('img.component-icon').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
          const geometry=await list.evaluate(list=>({columns:new Set([...list.children].map(item=>Math.round(item.getBoundingClientRect().left))).size,overflow:list.closest('.page').scrollWidth>list.closest('.page').clientWidth+1,items:[...list.children].map(item=>{const icon=item.querySelector('img.component-icon'), main=item.querySelector('.plugin-item-main'),end=item.querySelector('.plugin-item-end'); const bounds=icon.getBoundingClientRect();return{height:item.getBoundingClientRect().height,iconWidth:bounds.width,iconHeight:bounds.height,naturalWidth:icon.naturalWidth,complete:icon.complete,src:icon.currentSrc,decorative:icon.alt===''&&icon.getAttribute('aria-hidden')==='true',buttonGap:end.getBoundingClientRect().left-main.getBoundingClientRect().right};})}));
          assert.equal(geometry.columns,width===1500?2:1); assert.equal(geometry.overflow,false);
          for (const item of geometry.items) {assert.equal(item.height,64);assert.equal(item.iconWidth,32);assert.equal(item.iconHeight,32);assert.ok(item.complete&&item.naturalWidth>0&&item.decorative);assert.ok(item.buttonGap>=-1);assert.ok(item.src.includes(type.toLowerCase()+'-'));}
          await frame(`${type.toLowerCase()}-${theme}-${width}.png`); checks.push({theme,width,type,geometry});
        }
      }
      await tab('Skill').click(); await page.getByRole('button',{name:`查看 ${fixtures.Skill.name}`,exact:true}).click();
      const detail=page.locator('.skill-detail'); await detail.waitFor(); await detail.locator('.skill-detail-icon img').evaluate(image=>image.decode());
      const image=await detail.locator('.skill-detail-icon img').evaluate(i=>({width:i.getBoundingClientRect().width,naturalWidth:i.naturalWidth,src:i.currentSrc})); assert.equal(image.width,32);assert.ok(image.src.includes('/skill-'));
      await frame(`skill-detail-${theme}-660.png`); checks.push({theme,type:'Skill detail',image});
      await detail.getByRole('button',{name:'关闭详情',exact:true}).click(); await detail.waitFor({state:'hidden'});
      await tab('MCP').click();await page.getByRole('button',{name:`查看 ${fixtures.MCP.name}`,exact:true}).click();
      const mcpDetail=page.locator('.source-detail');await mcpDetail.locator('.component-detail-heading img').waitFor();await mcpDetail.locator('.component-detail-heading img').evaluate(image=>image.decode());await frame(`mcp-detail-${theme}-660.png`);
      checks.push({theme,type:'MCP detail'});
      await tab('Plugin').click();await page.getByRole('button',{name:`查看 ${fixtures.Plugin.name}`,exact:true}).click();
      const pluginDetail=page.locator('.plugin-detail-page'); await pluginDetail.waitFor(); await pluginDetail.locator('img.component-icon').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
      assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await pluginDetail.getByRole('button',{name:/查看 Skill/}).count(),1);
      await frame(`plugin-detail-${theme}-660.png`);checks.push({theme,type:'Plugin detail'});
      await pluginDetail.getByRole('button',{name:'管理',exact:true}).click();
      const manager=page.getByRole('dialog');await manager.waitFor();
      if(process.env.WORKDAY_PLUGIN_MANAGEMENT_VERIFY==='1') {
        const layout=await manager.evaluate(d=>({height:d.getBoundingClientRect().height,illustrations:d.querySelectorAll('.empty-art').length,sections:[...d.querySelectorAll('.plugin-management-section>h3')].map(h=>h.textContent),empty:[...d.querySelectorAll('.plugin-management-empty')].map(e=>({text:e.textContent,height:e.getBoundingClientRect().height})),rows:[...d.querySelectorAll('.plugin-management-skill')].map(r=>{const name=r.querySelector('.component-name').getBoundingClientRect();return{height:r.getBoundingClientRect().height,right:name.right,buttons:[...r.querySelectorAll('button')].map(b=>({left:b.getBoundingClientRect().left,width:b.getBoundingClientRect().width}))};})}));
        assert.equal(layout.illustrations,0);assert.deepEqual(layout.sections,['Skill1','MCP0']);assert.ok(layout.height<500);assert.ok(layout.empty.every(e=>e.height<25));
        assert.ok(layout.rows.every(r=>r.height<65&&r.buttons.every(b=>b.left>=r.right&&b.width>=48)));
        await frame(`plugin-management-${theme}-660.png`);checks.push({theme,type:'Plugin management compact layout',layout});
        await manager.getByRole('button',{name:'查看',exact:true}).click();await page.locator('.skill-detail').waitFor();await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.locator('.plugin-management').waitFor();
        await manager.getByRole('button',{name:'停用',exact:true}).click();await manager.getByRole('button',{name:'启用',exact:true}).waitFor();
        assert.equal((await call('state.get')).skills.find(s=>s.id===fixtures.Plugin.skillIds[0]).enabled,false);
        await manager.getByRole('button',{name:'启用',exact:true}).click();await manager.getByRole('button',{name:'停用',exact:true}).waitFor();
        assert.equal((await call('state.get')).skills.find(s=>s.id===fixtures.Plugin.skillIds[0]).enabled,true);
        checks.push({theme,type:'Owned Skill detail return and toggle via real isolated IPC'});
      }
      await manager.getByRole('button',{name:'关闭对话框',exact:true}).click();await manager.waitFor({state:'hidden'});
      await pluginDetail.getByRole('button',{name:/查看 Skill/}).click();
      const owned=page.locator('.skill-detail');await owned.waitFor();await owned.getByRole('button',{name:'关闭详情',exact:true}).click();await owned.waitFor({state:'hidden'});
      await pluginDetail.getByRole('button',{name:'返回插件',exact:true}).click();await pluginDetail.waitFor({state:'hidden'});
    }
    // Trial uses real isolated IPC and must never send a model request.
    await page.getByRole('button',{name:`查看 ${fixtures.Plugin.name}`,exact:true}).click();
    const before=(await call('state.get')).conversations.length;
    await page.getByRole('button',{name:'立即试用',exact:true}).click();
    await page.locator('.composer-input textarea').waitFor();
    let snapshot=await call('state.get');const trial=snapshot.conversations.find(c=>c.title===fixtures.Plugin.name);
    assert.equal(snapshot.conversations.length,before+1);assert.ok(trial);
    assert.equal(trial.context.pluginRefs[0].id,fixtures.Plugin.id);assert.equal(trial.context.skillRef.id,fixtures.Plugin.skillIds[0]);
    assert.deepEqual(await call('conversations.history',{id:trial.id}),[]);
    checks.push({type:'single Skill trial uses real context and sends nothing'});
    assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__defaultIconFixture.external),[]);
    const runtime=await app.evaluate(({app})=>({data:app.getPath('userData'),app:app.getAppPath()}));assert.equal(await fs.realpath(runtime.data),data);assert.equal(runtime.app,appRoot);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,frames,runtime,errors,personalData:false,realModel:false,mcpConnections:0,scriptRuns:0},null,2));
    console.log(JSON.stringify({passed:true,checks:checks.length,frames:frames.length,output}));
  } catch(error) {await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,frames,errors},null,2));throw error;}
  finally { if(app)await app.close().catch(()=>{});await fs.rm(data,{recursive:true,force:true});await fs.rm(packages,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
