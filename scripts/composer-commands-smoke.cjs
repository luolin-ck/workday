const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const red = process.argv.includes('--red');
  const output = process.env.WORKDAY_SMOKE_OUTPUT
    ? path.resolve(process.env.WORKDAY_SMOKE_OUTPUT)
    : path.join(root, 'output/playwright', 'composer-commands-' + kind);
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-composer-commands-')));
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, red ? 'red.json' : 'result.json'), { force: true });
  await fs.rm(path.join(output, red ? 'red-failure.json' : 'failure.json'), { force: true });
  const checks = [], frames = [], errors = [], requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 1000000); }
      const body = JSON.parse(raw); requests.push(body);
      assert.equal(body.model === 'plain' || body.model === 'alternate', true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'COMPOSER_SYNTHETIC_REPLY' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Synthetic fixture failure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let app, page;
  const input = () => page.getByRole('textbox', { name: '消息输入', exact: true });
  const list = name => page.getByRole('listbox', { name, exact: true });
  const call = async (op, payload = {}) => {
    const result = await page.evaluate(({ op, payload }) => window.workday.call(op, payload), { op, payload });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  async function until(predicate, label) {
    const end = Date.now() + 12000;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw Error('Timed out: ' + label);
  }
  async function frame(name) {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    assert.ok(png.length > 1000); await fs.writeFile(path.join(output, name), Buffer.from(png, 'base64')); frames.push(name);
  }
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env, timeout: 30000 }, { mockHolidays: true, keychain: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:\/\//, route => route.abort());
    await app.evaluate(({ app, BrowserWindow, dialog, ipcMain, net }, { data, base }) => {
      if (app.getPath('userData') !== data) throw Error('Fixture data directory mismatch');
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1320, 900); window.showInactive();
      globalThis.__composerFixture = { files: [], cancel: false, delay: 0, package: '', calls: [], blocked: [] };
      dialog.showOpenDialog = async options => {
        const fixture = globalThis.__composerFixture;
        if (options.title === '添加聊天附件') { const files = [...fixture.files], cancel = fixture.cancel; await new Promise(resolve => setTimeout(resolve, fixture.delay)); return { canceled: cancel, filePaths: cancel ? [] : files }; }
        if (options.title === '选择插件目录') return { canceled: false, filePaths: [fixture.package] };
        throw Error('Unexpected synthetic dialog: ' + options.title);
      };
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, payload) => {
        const fixture = globalThis.__composerFixture;
        if (['sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save'].includes(op)) { fixture.blocked.push(op); throw Error('External operation blocked'); }
        if (['chat.send', 'conversations.create', 'context.attachments.pick'].includes(op)) fixture.calls.push({ op, payload });
        return original(event, op, payload);
      });
      const fetch = net.fetch.bind(net);
      net.fetch = (url, init) => {
        const target = new URL(typeof url === 'string' ? url : url.url ?? url.href);
        if (target.origin !== base && !['ipwho.is', 'geocoding-api.open-meteo.com', 'api.open-meteo.com', 'sousuo.www.gov.cn'].includes(target.hostname)) { globalThis.__composerFixture.blocked.push(target.origin); throw Error('Only synthetic providers allowed'); }
        return fetch(url, init);
      };
    }, { data, base });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await input().waitFor();
    if (!red) {
      await input().fill('/model'); await list('快捷命令').waitFor();
      await list('快捷命令').getByRole('option').filter({ hasText: '切换模型' }).click();
      await page.getByRole('tab', { name: '模型源', exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: '模型源', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(requests.length, 0);
      await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: 'Home', exact: true }).click();
      await input().waitFor();
      checks.push('/model without configured models opens actual model source settings instead of a no-op');
    }
    const source = await call('sources.save', { name: 'Composer synthetic source', baseUrl: base + '/v1', models: [{ id: 'plain', name: '模拟模型 A', supportsTools: true }, { id: 'alternate', name: '模拟模型 B', supportsTools: true }] });
    const model = { sourceId: source.id, modelId: 'plain' }; await call('settings.defaultModel', { model });
    await input().fill('@');
    try { await list('上下文建议').waitFor({ timeout: 2000 }); }
    catch (error) {
      await frame('red-missing-at-menu.png');
      const evidence = { expectedBehaviorMissing: true, assertion: 'Typing @ in real shared Home composer exposes the 上下文建议 listbox', actualListboxes: await page.getByRole('listbox').count(), input: await input().inputValue(), kind, mockRequests: requests.length, realModel: false, personalData: false };
      if (red) await fs.writeFile(path.join(output, 'red.json'), JSON.stringify(evidence, null, 2));
      throw Error('BUSINESS RED: @ context suggestions absent from live Home composer');
    }
    assert.equal(red, false, '--red expected the original behavior to be absent');
    checks.push('Real Home composer opens @ context suggestions');
    await input().press('Escape');
    const emptyContext = { date: null, taskIds: [], knowledgeRefs: [], skillRef: null, mcpRefs: [] };
    async function completed(id, requestId) {
      await until(async () => (await call('conversations.history', { id })).some(message => message.requestId === requestId && message.role === 'assistant' && message.status === 'complete'), 'synthetic reply committed');
    }
    const reference = await call('conversations.create', { title: '引用对话', projectId: null, date: null, model });
    const referenceSend = await call('chat.send', { conversationId: reference.id, text: 'SELECTED_CONVERSATION_SENTINEL', model, context: emptyContext });
    await completed(reference.id, referenceSend.requestId);
    const skill = await call('skills.save', { name: '写作规范', description: 'Synthetic workflow', descriptionZh: '用于隔离验收的写作规范。', content: 'SELECTED_SKILL_SENTINEL' });
    const knowledge = await call('knowledge.save', { name: '全局资料', content: 'SELECTED_KNOWLEDGE_SENTINEL', projectId: null });
    await call('knowledge.save', { name: '不选资料', content: 'UNSELECTED_KNOWLEDGE_SENTINEL', projectId: null });
    const folder = path.join(data, 'project'); await fs.mkdir(folder);
    const project = await call('projects.save', { name: '快捷命令测试项目', description: 'Synthetic empty workspace', directory: folder });
    await call('knowledge.save', { name: '其他项目资料', content: 'WRONG_PROJECT_KNOWLEDGE_SENTINEL', projectId: project.id });
    const pluginPath = path.join(data, 'plugin'); await fs.mkdir(path.join(pluginPath, 'skills/sample'), { recursive: true });
    await fs.writeFile(path.join(pluginPath, 'workday-plugin.json'), JSON.stringify({ id: 'composer-fixture', name: '上下文插件', version: '1.0.0', description: 'Synthetic selectable components', descriptionZh: '隔离测试的组件选择。', appVersion: '0.1', skills: ['skills/sample/SKILL.md'], mcp: ['mcp.json'] }));
    await fs.writeFile(path.join(pluginPath, 'skills/sample/SKILL.md'), '---\nname: sample\ndescription: Synthetic plugin workflow\n---\nSELECTED_PLUGIN_SKILL_SENTINEL');
    await fs.writeFile(path.join(pluginPath, 'mcp.json'), JSON.stringify({ name: 'Never connected', transport: 'http', command: '', args: [], url: 'https://composer-fixture.invalid/mcp' }));
    await app.evaluate((_, directory) => { globalThis.__composerFixture.package = directory; }, pluginPath);
    const preview = await call('plugins.preview'); const plugin = await call('plugins.install', { token: preview.token });
    const packageSkill = (await call('state.get')).skills.find(item => plugin.skillIds.includes(item.id)); assert.ok(packageSkill);
    const attachments = Array.from({ length: 7 }, (_, i) => path.join(data, `attachment-${i}.txt`));
    await Promise.all(attachments.map((file, i) => fs.writeFile(file, `SELECTED_ATTACHMENT_SENTINEL_${i}`)));
    async function mention(name, selectWith = 'mouse', prefix = '') {
      await input().fill(prefix + '@' + name);
      await list('上下文建议').waitFor();
      const item = list('上下文建议').getByRole('option').filter({ hasText: name }); await item.waitFor();
      assert.equal(await item.count(), 1, 'one filtered context candidate');
      if (selectWith === 'mouse') await item.click(); else await input().press(selectWith);
      await list('上下文建议').waitFor({ state: 'hidden' });
    }
    async function command(name, title, key) {
      const count = requests.length;
      await input().fill('/' + name); await list('快捷命令').waitFor();
      const option = list('快捷命令').getByRole('option').filter({ hasText: title }); await option.waitFor();
      if (key) await input().press(key); else await option.click();
      await list('快捷命令').waitFor({ state: 'hidden' });
      assert.equal(requests.length, count, '/' + name + ' does not send command text');
    }
    async function sent(text) {
      const before = requests.length;
      await input().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await until(async () => requests.length === before + 1, 'one captured local HTTP request');
      const captured = await app.evaluate(() => globalThis.__composerFixture.calls.filter(call => call.op === 'chat.send').at(-1));
      await until(async () => !(await call('state.get')).conversations.find(item => item.id === captured.payload.conversationId)?.activeRequestId, 'generation ended');
      return { body: requests.at(-1), payload: captured.payload };
    }

    await mention('引用对话', 'Tab', '请参考 ');
    assert.equal(await input().inputValue(), '请参考 '); await page.getByRole('button', { name: '移除上下文 引用对话', exact: true }).waitFor();
    await mention('写作规范', 'Enter');
    await page.getByRole('button', { name: '移除上下文 写作规范', exact: true }).waitFor();
    await mention('全局资料');
    await input().fill('@其他项目资料');
    assert.equal(await list('上下文建议').getByRole('option').filter({ hasText: '其他项目资料' }).count(), 0);
    await input().press('Escape');
    await frame('home-selected-context.png');
    const homeSend = await sent('HOME_COMPOSER_CONTEXT_SEND');
    assert.ok(JSON.stringify(homeSend.body).includes('SELECTED_CONVERSATION_SENTINEL'));
    assert.ok(JSON.stringify(homeSend.body).includes('SELECTED_SKILL_SENTINEL'));
    assert.ok(JSON.stringify(homeSend.body).includes('SELECTED_KNOWLEDGE_SENTINEL'));
    assert.doesNotMatch(JSON.stringify(homeSend.body), /UNSELECTED_KNOWLEDGE_SENTINEL|WRONG_PROJECT_KNOWLEDGE_SENTINEL|SELECTED_PLUGIN_SKILL_SENTINEL/);
    assert.deepEqual(homeSend.payload.context.skillRef, { id: skill.id, version: skill.version });
    assert.deepEqual(homeSend.payload.context.knowledgeRefs, [{ id: knowledge.id, version: knowledge.version }]);
    assert.equal(homeSend.payload.context.conversationRefs.length, 1);
    assert.equal(homeSend.payload.context.conversationRefs[0].id, reference.id);
    assert.ok(homeSend.payload.context.conversationRefs[0].digest); assert.ok(homeSend.payload.context.conversationRefs[0].version);
    checks.push('Home @ conversation/Skill/knowledge select real versioned references; exact selected contents reach local HTTP and unselected/wrong-project materials do not');

    await mention('上下文插件');
    const pluginDialog = page.getByRole('dialog', { name: '选择插件组件', exact: true }); await pluginDialog.waitFor();
    await pluginDialog.getByText('上下文插件 · 选择具体组件', { exact: true }).waitFor();
    assert.equal(await pluginDialog.getByRole('button', { name: '添加所选组件', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '移除上下文 上下文插件', exact: true }).count(), 0);
    await pluginDialog.getByText('此聊天暂无已授权的插件 MCP 能力。', { exact: false }).waitFor();
    await frame('plugin-explicit-components.png');
    await pluginDialog.getByRole('checkbox', { name: new RegExp(packageSkill.name) }).check();
    await pluginDialog.getByRole('button', { name: '添加所选组件', exact: true }).click();
    await pluginDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '移除上下文 上下文插件', exact: true }).waitFor();
    const pluginSend = await sent('PROJECT_PLUGIN_CONTEXT_SEND');
    assert.ok(JSON.stringify(pluginSend.body).includes('SELECTED_PLUGIN_SKILL_SENTINEL'));
    assert.deepEqual(pluginSend.payload.context.skillRef, { id: packageSkill.id, version: packageSkill.version });
    assert.equal(pluginSend.payload.context.pluginRefs.length, 1); assert.equal(pluginSend.payload.context.pluginRefs[0].id, plugin.id);
    assert.deepEqual(pluginSend.payload.context.pluginRefs[0].mcpRefs, []);
    checks.push('Existing chat @ Plugin opens concrete component confirmation; only explicit Skill is sent and unauthorized MCP remains unselected/unconnected');

    let dialog;
    await command('skill', '选择 Skill');
    dialog = page.getByRole('dialog', { name: '选择 Skill', exact: true });
    await dialog.getByRole('button').filter({ hasText: '写作规范' }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '移除上下文 写作规范', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '移除上下文 上下文插件', exact: true }).count(), 0);
    checks.push('/skill selects a real independent Skill and clears previous Plugin ownership');
    await command('plugin', '选择插件'); await pluginDialog.waitFor();
    await pluginDialog.getByRole('button').filter({ hasText: '上下文插件' }).click();
    await pluginDialog.getByRole('checkbox', { name: new RegExp(packageSkill.name) }).check();
    await pluginDialog.getByRole('button', { name: '添加所选组件', exact: true }).click();
    await pluginDialog.waitFor({ state: 'hidden' });
    checks.push('/plugin opens the same real Plugin selector and applies explicitly selected components');
    await command('model', '切换模型', 'Tab');
    await page.getByRole('option', { name: '模拟模型 B', exact: true }).click();
    assert.equal(await page.getByRole('combobox', { name: '选择模型与模型源', exact: true }).inputValue(), '模拟模型 B');
    checks.push('/model expands the existing model dropdown and changes current selection');

    await app.evaluate(() => { globalThis.__composerFixture.cancel = true; });
    await command('attach', '上传附件');
    await until(() => page.getByRole('button', { name: '添加上下文', exact: true }).isEnabled(), 'canceled file dialog unlocks composer');
    assert.equal(await page.getByRole('button', { name: /^移除附件 attachment-/ }).count(), 0);
    await app.evaluate((_, file) => { globalThis.__composerFixture.cancel = false; globalThis.__composerFixture.files = [file]; globalThis.__composerFixture.delay = 350; }, attachments[0]);
    await command('attach', '上传附件');
    await page.getByRole('button', { name: '移除附件 attachment-0.txt', exact: true }).waitFor();
    await app.evaluate((_, files) => { globalThis.__composerFixture.files = files; globalThis.__composerFixture.delay = 0; }, attachments.slice(1));
    await command('attach', '上传附件');
    await page.getByRole('alert').filter({ hasText: '每条消息最多 6 个附件，请先移除部分附件' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^移除附件 attachment-/ }).count(), 1);
    const attachmentSend = await sent('ATTACH_COMMAND_SEND');
    assert.equal(attachmentSend.body.model, 'alternate');
    assert.ok(JSON.stringify(attachmentSend.body).includes('SELECTED_ATTACHMENT_SENTINEL_0'));
    assert.doesNotMatch(JSON.stringify(attachmentSend.body), /SELECTED_ATTACHMENT_SENTINEL_[1-6]/);
    assert.equal(attachmentSend.payload.context.attachmentRefs.length, 1);
    checks.push('/attach supports real isolated file picking, cancellation and existing six-file limit; chosen file and /model selection reach HTTP');

    const projectChat = await call('conversations.create', { title: '项目草稿测试', projectId: project.id, date: null, model });
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await page.locator('.conversation-list').getByRole('button', { name: projectChat.title, exact: true }).click();
    await input().fill('/new 保留原项目草稿');
    await input().press('Meta+ArrowLeft');
    for (let i = 0; i < 4; i++) await input().press('ArrowRight');
    await list('快捷命令').waitFor();
    const beforeNew = (await call('state.get')).conversations.map(item => item.id);
    await input().press('Enter');
    await until(async () => (await call('state.get')).conversations.length === beforeNew.length + 1, '/new creates exactly one conversation');
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterNew = (await call('state.get')).conversations.filter(item => !beforeNew.includes(item.id));
    assert.equal(afterNew.length, 1); assert.equal(afterNew[0].projectId, project.id);
    assert.equal((await call('conversations.history', { id: afterNew[0].id })).length, 0);
    await until(async () => await input().inputValue() === '', 'new chat opens with empty draft');
    await page.locator('.conversation-list').getByRole('button', { name: projectChat.title, exact: true }).click();
    await until(async () => await input().inputValue() === ' 保留原项目草稿', 'original project draft restored');
    assert.equal(await input().inputValue(), ' 保留原项目草稿');
    checks.push('/new creates exactly one unsent chat in current project and retains the original draft after consuming its command');

    await page.getByRole('button',{name:'添加上下文',exact:true}).click();
    await page.getByRole('menuitem',{name:'上传附件',exact:true}).waitFor();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['上传附件','选择对话','Skill','插件']);
    await frame('context-menu.png');await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});await input().click();
    await input().fill('/'); await list('快捷命令').waitFor();
    await until(async()=>await list('快捷命令').getByRole('option').count()===5,'five command options rendered');
    await frame('chat-slash-wide.png');
    await input().press('Escape');
    await input().fill('@'); await list('上下文建议').waitFor();
    await frame('chat-at-wide.png');
    await input().press('Escape');
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button',{name:'添加上下文',exact:true}).click();
    await page.getByRole('menuitem',{name:'上传附件',exact:true}).waitFor();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['上传附件','选择对话','Skill','插件']);
    await frame('context-menu.png');await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});await input().click();
    await input().fill('/'); await list('快捷命令').waitFor();
    await until(async()=>await list('快捷命令').getByRole('option').count()===5,'five command options rendered');
    await frame('home-slash-wide.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 900));
    await until(async () => await page.evaluate(() => innerWidth === 660), 'narrow viewport');
    await input().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const menuBounds = await list('快捷命令').boundingBox();
    const viewportHeight = await page.evaluate(() => innerHeight), inputBounds = await input().boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 661 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= viewportHeight);
    assert.ok(inputBounds && inputBounds.y >= 0 && inputBounds.y + inputBounds.height <= viewportHeight, 'narrow input is in view');
    await frame('home-slash-narrow.png');
    checks.push('Home and existing chat share all five commands; narrow popover remains inside viewport');
    const isolation = await app.evaluate(() => ({ blocked: globalThis.__composerFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls }));
    assert.deepEqual(isolation.blocked, []); assert.equal(isolation.nativeCalls, 0); assert.equal(isolation.credentialCalls, 0); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, frames, actualHttpBodies: requests.length, realModel: false, personalData: false, realCredentials: false, actualMcpCalls: 0, isolation, runtime: await app.evaluate(({ app }) => ({ app: app.getAppPath(), executable: process.execPath, isolated: app.getPath('userData') })) }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    await fs.writeFile(path.join(output, red ? 'red-failure.json' : 'failure.json'), JSON.stringify({ error: String(error), checks, frames, errors, actualHttpBodies: requests.length }, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => undefined);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await fs.rm(data, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
