// Isolated UI acceptance for the shared component split action button. No model is configured.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {_electron} = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const {launchWithWeatherFixture} = require('./electron-fixture-launch.cjs');
const names = {skill: 'Skill', mcp: 'MCP', plugin: 'Plugin'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(root) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of (await fs.readdir(path.join(root, relative), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push([file, digest(await fs.readFile(path.join(root, file)))]);
    }
  }
  await visit(); return {sha256: digest(JSON.stringify(files)), files};
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const mode = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const phase = process.env.WORKDAY_ACTION_PHASE || 'green';
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/component-actions-' + phase + '-' + mode + '-' + runId));
  const evidence = path.join(root, 'test-results/component-actions/' + phase + '-' + mode + '-' + runId + '.json');
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-component-actions-')));
  await fs.mkdir(output, {recursive: true}); await fs.mkdir(path.dirname(evidence), {recursive: true});
  const checks = [], frames = [], errors = [];
  const source = await fingerprint(path.join(root, 'src'));
  const dist = await fingerprint(mode === 'stage' ? path.resolve(path.dirname(process.env.WORKDAY_ELECTRON_EXECUTABLE), '../Resources/app/dist') : path.join(root, 'dist'));
  let app, page, result;
  const call = async (op, input = {}) => {
    const response = await page.evaluate(({op,input}) => window.workday.call(op,input), {op,input});
    assert.equal(response.ok, true, JSON.stringify(response)); return response.value;
  };
  const frame = async name => {
    await page.mouse.move(0,0);
    // Menu visibility precedes its opacity transition; wait for paint before native capture.
    await page.waitForFunction(() => [...document.querySelectorAll('[role="menu"]')].filter(el => el.getBoundingClientRect().width > 0).every(el => getComputedStyle(el).opacity === '1'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bytes = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64')); frames.push(name);
  };
  const nav = () => page.getByRole('navigation', {name:'全局导航'}).getByRole('button', {name:'插件',exact:true});
  const group = kind => page.getByRole('group', {name: names[kind] + ' 新增操作', exact:true});
  const primary = kind => group(kind).getByRole('button', {name:'新增 ' + names[kind], exact:true});
  const more = kind => group(kind).getByRole('button', {name:names[kind] + ' 更多操作', exact:true});
  async function open(kind) {
    await nav().click(); await page.getByRole('tab', {name:names[kind],exact:true}).click();
    await page.getByRole('tabpanel').waitFor();
  }
  async function enter(kind, intent, repeat = false) {
    await open(kind);
    const before = await call('state.get'), ids = new Set(before.conversations.map(c => c.id));
    if (intent === 'create') {
      if (repeat) {
        await app.evaluate(() => {globalThis.__componentActions.delayStart = true;});
        await primary(kind).evaluate(button => {button.click();button.click();});
      } else await primary(kind).click();
    } else {
      await more(kind).click(); await page.getByRole('menuitem', {name:'导入 ' + names[kind],exact:true}).click();
    }
    await page.getByRole('button', {name:'结束管理',exact:true}).waitFor();
    const input = page.getByRole('textbox', {name:'消息输入',exact:true}); await input.waitFor();
    const created = (await call('state.get')).conversations.filter(c => !ids.has(c.id));
    assert.equal(created.length, 1, 'One action creates exactly one management conversation');
    assert.deepEqual(created[0].componentMode, {kind,intent});
    assert.equal(created[0].context.skillRef, null);
    assert.equal(created[0].model, null);
    assert.equal((await call('conversations.history', {id:created[0].id})).length, 0);
    assert.ok((await input.inputValue()).includes(intent === 'import' ? '导入' : kind === 'mcp' ? '添加' : '创建'));
    const sentinel = `UNSENT_${kind}_${intent}`;
    await input.fill(sentinel);
    await open(kind);
    const snapshot = (await call('state.get')).conversations.length;
    await more(kind).click(); await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
    assert.equal((await call('state.get')).conversations.length, snapshot, 'Opening and dismissing action menu creates nothing');
    await page.getByRole('navigation', {name:'全局导航'}).getByRole('button', {name:'项目',exact:true}).click();
    await page.getByRole('textbox', {name:'消息输入',exact:true}).waitFor();
    await page.waitForFunction(sentinel => document.querySelector('[aria-label="消息输入"]')?.value === sentinel, sentinel);
    checks.push(`${names[kind]} ${intent}: correct internal mode, unsent seed, one conversation, and draft survives menu visit`);
  }
  try {
    const env = {...process.env,WORKDAY_DATA_DIR:data}; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, {executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args:mode === 'source' ? [root] : [], env, timeout:30000}, {mockHolidays:true,keychain:true});
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\//, route => {errors.push('Unexpected renderer network');return route.abort();});
    await app.evaluate(({app,BrowserWindow,ipcMain}, data) => {
      if (app.getPath('userData') !== data) throw Error('Isolated data mismatch');
      const window = BrowserWindow.getAllWindows()[0];window.setSize(1400,950);window.showInactive();window.webContents.setBackgroundThrottling(false);
      globalThis.__componentActions = {calls:[],blocked:[],overlay:false,delayStart:false};
      const original = ipcMain._invokeHandlers.get('workday:call');ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call',async (event,op,input) => {
        const fixture = globalThis.__componentActions;fixture.calls.push({op,input});
        if (/^(chat\.(send|retry|continue)|sources\.|schedules\.run|mcp\.(discover|call|toggle)|git\.|projects\.download|skills\.approveRun|grants\.save|components\.(migrate|restoreMigration))$/.test(op) || op.startsWith('sources.') || op.startsWith('git.')) {
          fixture.blocked.push(op);throw Error('External or destructive action blocked in UI fixture');
        }
        if (op === 'components.start' && fixture.delayStart) {fixture.delayStart = false;await new Promise(resolve => setTimeout(resolve,200));}
        if (op === 'components.previewLegacy') return {ok:true,value:{token:'synthetic-preview',inputHash:'synthetic',skills:0,plugins:0,preserved:0,added:0,completed:true,items:[]}};
        const response = await original(event,op,input);
        if (op === 'state.get' && response.ok && fixture.overlay) return {...response,value:{...response.value,componentMigration:{recoveryId:'synthetic-recovery'},plugins:fixture.overlay==='recovery-only'?response.value.plugins:[...response.value.plugins,{id:'00000000-0000-4000-8000-000000000001',name:'Fixture legacy package',description:'Synthetic state overlay only',pluginKey:'codex-skills-01',version:1,createdAt:'2026-01-01',updatedAt:'2026-01-01',packageVersion:'1.0',enabled:false,skillIds:[],mcpIds:[]}]}};
        return response;
      });
    }, data);
    await page.getByRole('navigation', {name:'全局导航'}).waitFor();
    await open('skill'); await frame('initial-toolbar.png');
    assert.equal(await group('skill').count(), 1, 'BUSINESS RED: Skill toolbar must expose one shared split action group');
    for (const kind of ['skill','mcp','plugin']) {
      await open(kind); await group(kind).waitFor();
      assert.equal((await primary(kind).innerText()).trim(), '新增');
      assert.equal(await group(kind).getByRole('button').count(), 2);
      assert.equal(await page.getByRole('button', {name:'导入 ' + names[kind],exact:true}).count(), 0, 'Import is not a separate toolbar button');
      const before = (await call('state.get')).conversations.length;
      await more(kind).focus(); await more(kind).press('Enter'); await page.getByRole('menu').waitFor();
      await page.getByRole('menuitem', {name:'导入 ' + names[kind],exact:true}).waitFor();
      assert.equal(await page.getByRole('menuitem',{name:/脚本运行时|恢复迁移/}).count(),0,'Removed maintenance actions must not appear');
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['导入 '+names[kind]]);
      assert.equal(await page.getByRole('menu').locator('.mantine-Menu-divider').count(),0);
      if (kind === 'plugin') assert.equal(await page.getByRole('menuitem',{name:/整理旧导入|恢复迁移/}).count(),0);
      await frame(kind + '-menu.png');
      await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
      assert.equal(await more(kind).evaluate(e => document.activeElement === e), true, 'Escape restores focus to menu trigger');
      assert.equal((await call('state.get')).conversations.length,before);
      checks.push(`${names[kind]} split action is compact, default add, keyboard accessible, and has no eager side effects`);
    }
    for (const kind of ['skill','mcp','plugin']) for (const intent of ['create','import']) await enter(kind,intent,kind === 'skill' && intent === 'create');
    const starts = await app.evaluate(() => globalThis.__componentActions.calls.filter(c => c.op === 'components.start'));
    assert.equal(starts.length,6,'Repeated primary clicks are guarded while authoring is busy');
    checks.push('Busy primary action does not create duplicate management conversations');
    await app.evaluate(({BrowserWindow}) => {globalThis.__componentActions.overlay=true;BrowserWindow.getAllWindows()[0].webContents.send('workday:event',{type:'stateChanged'});});
    await open('plugin');await more('plugin').click();await page.getByRole('menuitem',{name:'整理旧导入',exact:true}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'恢复迁移',exact:true}).count(),0);assert.equal(await page.getByRole('menu').locator('.mantine-Menu-divider').count(),1);await frame('plugin-migration-menu.png');
    await page.getByRole('menuitem',{name:'整理旧导入',exact:true}).click();await page.getByRole('dialog',{name:'整理旧导入',exact:true}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    checks.push('Legacy import preview remains; restore action is absent even when a recovery record exists');
    await app.evaluate(({BrowserWindow})=>{globalThis.__componentActions.overlay='recovery-only';BrowserWindow.getAllWindows()[0].webContents.send('workday:event',{type:'stateChanged'});});
    await open('plugin');await more('plugin').click();await page.getByRole('menuitem',{name:'导入 Plugin',exact:true}).waitFor();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['导入 Plugin']);assert.equal(await page.getByRole('menu').locator('.mantine-Menu-divider').count(),0);
    await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});
    checks.push('Recovery-only state shows a single import item without an orphan separator or restore modal');
    for (const width of [1400,760]) {
      await app.evaluate(({BrowserWindow},width) => BrowserWindow.getAllWindows()[0].setSize(width,950),width);await page.waitForFunction(width => innerWidth===width,width);
      for (const kind of ['skill','mcp','plugin']) {
        await open(kind);const layout=await group(kind).evaluate(el=>{const rect=el.getBoundingClientRect(),buttons=[...el.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});return{x:rect.x,right:rect.right,width:rect.width,buttons,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};});
        assert.equal(layout.overflow,false);assert.ok(layout.x>=0&&layout.right<=layout.viewport+1);assert.equal(layout.buttons.length,2);assert.ok(Math.abs(layout.buttons[0].y-layout.buttons[1].y)<=1);assert.ok(layout.width<240,'Split button does not expand to full toolbar');
        await more(kind).click();const menu=await page.getByRole('menu').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=width+1);await frame(`${kind}-${width}.png`);await page.keyboard.press('Escape');
      }
    }
    checks.push('All three split controls and menus stay compact and inside both wide and narrow viewports');
    const runtime=await app.evaluate(()=>globalThis.__componentActions);assert.deepEqual(runtime.blocked,[]);assert.equal(runtime.calls.filter(c=>c.op==='components.restoreMigration'||c.op==='components.migrate'||c.op==='skills.runtime').length,0);assert.deepEqual(errors,[]);
    assert.equal((await fingerprint(path.join(root,'src'))).sha256,source.sha256,'Source unchanged during acceptance');
    result={passed:true,mode,phase,runId,source,dist,checks,frames,starts:starts.map(({input})=>input),realModel:false,personalData:false,destructiveActions:false,pageErrors:errors};
  } catch(error) {
    if(page) await frame('failure.png').catch(()=>{});
    result={passed:false,mode,phase,runId,error:String(error),source,dist,checks,frames,pageErrors:errors};
    process.exitCode=1;
  } finally {
    if(app) await app.close();await fs.rm(data,{recursive:true,force:true});
    await fs.writeFile(evidence,JSON.stringify(result,null,2)+'\n');await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({passed:result.passed,checks:checks.length,evidence,output,error:result.error}));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
