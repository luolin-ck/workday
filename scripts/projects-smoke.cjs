const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { createMockServer } = require('./mock-model.cjs');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { selectDropdown, selectModel, storedModelValue } = require('./model-picker-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = await fs.mkdtemp(path.join(root, 'test-data', `projects-${kind}-`));
  const output = path.join(root, 'output', 'playwright', 'projects', kind);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const folder = path.join(data, 'example-folder'); await fs.mkdir(folder);
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const mock = createMockServer();
  await new Promise((resolve, reject) => { mock.server.once('error', reject); mock.server.listen(0, '127.0.0.1', resolve); });
  const checks = [], errors = []; let app, page;
  const rawCall = (op, input) => page.evaluate(({op, input}) => window.workday.call(op, input), {op, input});
  async function call(op, input) { const result = await rawCall(op, input); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  async function until(check, label) { for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('Timed out: ' + label); }
  const input = () => page.getByRole('textbox', {name: '消息输入', exact: true});
  const modelPicker = () => page.getByRole('combobox', {name: '选择模型与模型源', exact: true});
  const categories = () => page.locator('.project-categories');
  const group = id => categories().locator(`.project-group[data-project-id="${id ?? 'none'}"]`);
  const row = title => page.locator('.conversation-list .conversation-row').filter({has: page.getByRole('button', {name: title, exact: true})});
  const select = name => categories().getByRole('button', {name, exact: true});
  async function createProjectChat(project) {
    const previous = new Set((await call('state.get', {})).conversations.map(chat => chat.id));
    await (await menu('项目', project.name, '新建聊天')).click();
    let created;
    await until(async () => { created = (await call('state.get', {})).conversations.find(chat => !previous.has(chat.id) && chat.projectId === project.id); return !!created; }, 'project menu creates its chat');
    return created;
  }
  async function compactChat() {
    const chat = page.getByRole('region', {name: '聊天', exact: true});
    assert.equal(await chat.locator('.chat-heading,.chat-context,.destination,.empty').count(), 0);
    assert.equal(await chat.getByRole('button', {name: /^(展开对话区|收起对话区|新建项目聊天|新建无项目聊天|选择上下文|清除日期上下文)$/}).count(), 0);
    assert.equal(await chat.getByRole('button', {name: /^添加上下文/}).count(), 1, 'context remains available in the composer');
    assert.equal(await page.getByRole('button', {name: '新建聊天', exact: true}).count(), 1, 'new chat remains available in the project sidebar');
  }
  async function menu(kind, name, item) {
    await page.getByRole('button', {name: `${kind}操作 ${name}`, exact: true}).click();
    const entry = page.getByRole('menuitem', {name: item, exact: true}); await entry.waitFor(); return entry;
  }
  async function screenshot(name) {
    const closeNotice = page.getByRole('button', {name: '关闭提示', exact: true});
    if (await closeNotice.count()) await closeNotice.click();
    await page.mouse.move(0, 0);
    await until(async () => await page.getByRole('tooltip').count() === 0, 'tooltip closes before screenshot');
    await page.screenshot({path: path.join(output, name), fullPage: true});
  }
  async function start() {
    app = await launchWithWeatherFixture(_electron, {executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env, timeout: 30000}, {mockHolidays: true});
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', {name: '全局导航'}).waitFor();
  }
  async function chooseFolder(selected) {
    await app.evaluate(({dialog}, selected) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (...args) => {
        dialog.showOpenDialog = original;
        globalThis.__projectDialogOptions = args.at(-1);
        return {canceled: !selected, filePaths: selected ? [selected] : []};
      };
    }, selected);
    await page.getByRole('button', {name: '创建项目', exact: true}).click();
    await page.getByRole('menuitem', {name: '本地文件夹', exact: true}).click();
    await until(async () => !!await app.evaluate(() => globalThis.__projectDialogOptions), 'native directory dialog called');
    assert.deepEqual((await app.evaluate(() => globalThis.__projectDialogOptions)).properties, ['openDirectory']);
  }
  async function complete(id) {
    await until(async () => !(await call('state.get', {})).conversations.find(c => c.id === id).activeRequestId && (await call('conversations.history', {id})).some(m => m.role === 'assistant' && m.status === 'complete'), 'assistant completes');
  }
  try {
    await start(); const executable = await app.evaluate(() => process.execPath), versions = await app.evaluate(() => ({...process.versions}));
    await page.getByRole('button', {name: '项目', exact: true}).click();
    await compactChat();
    assert.equal(await page.getByText('从一个问题开始', {exact: true}).count(), 0);
    assert.equal(await page.getByLabel('显示已归档项目', {exact: true}).count(), 0);
    await chooseFolder(null); assert.equal((await call('state.get', {})).projects.length, 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await chooseFolder(folder);
    let dialog = page.getByRole('dialog', {name: '创建项目', exact: true}); await dialog.waitFor();
    assert.equal(await dialog.getByLabel('项目名称', {exact: true}).inputValue(), path.basename(folder));
    assert.equal(await dialog.getByRole('textbox', {name: /^项目文件夹/}).inputValue(), await fs.realpath(folder));
    await dialog.getByRole('button', {name: '取消', exact: true}).click();
    assert.equal((await call('state.get', {})).projects.length, 0);
    await chooseFolder(folder); await dialog.waitFor();
    await dialog.getByLabel('项目名称', {exact: true}).fill('自定义项目名称');
    await dialog.getByRole('button', {name: '保存', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
    const project = (await call('state.get', {})).projects[0];
    assert.equal(project.name, '自定义项目名称'); assert.equal(project.directory, await fs.realpath(folder));
    await (await menu('项目', project.name, '编辑项目')).click();
    dialog = page.getByRole('dialog', {name: '编辑项目', exact: true}); await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox', {name: /^项目文件夹/}).inputValue(), project.directory);
    await dialog.getByRole('button', {name: '取消', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
    checks.push('native openDirectory picker cancellation and editor cancellation create nothing; folder basename is editable and custom name/path are saved');

    const secondFolder = path.join(data, 'second-project'); await fs.mkdir(secondFolder);
    const longName = '用来验证项目树单行省略和完整提示的长名称项目';
    const second = await call('projects.save', {name: longName, description: '', directory: secondFolder});
    const linkedTask = await call('tasks.save', {title: '关联待办保留哨兵', notes: '', date: '2099-10-14', projectId: project.id, completed: false});
    const linkedKnowledge = await call('knowledge.save', {name: '关联资料保留哨兵', content: '本地保留内容', projectId: project.id});
    assert.equal(await page.locator('.project-page.panel, .project-detail, .associated, .archived-chats').count(), 0);
    assert.equal(await group(null).count(), 1, 'projectless navigation remains available for new chats');
    assert.equal(await group(null).locator('.conversation-row').count(), 0);
    await select(longName).hover(); await page.getByRole('tooltip').filter({hasText: longName}).waitFor();
    checks.push('project tree keeps projectless navigation and hides old overview/association panels; long project name has a complete tooltip');

    const source = await call('sources.save', {name: '本地模拟', baseUrl: `http://127.0.0.1:${mock.server.address().port}/v1`, models: [{id: 'workday-mock', name: '模拟模型', supportsTools: false}, {id: 'selection-only', name: '仅验证选择', supportsTools: false}]});
    const model = {sourceId: source.id, modelId: 'workday-mock'}; await call('settings.defaultModel', {model});
    const modelA = JSON.stringify([source.id, 'workday-mock']), modelB = JSON.stringify([source.id, 'selection-only']);
    const draftChats = [];
    for (const [destination, draft, selectedModel] of [[project, '项目 A 的未发送草稿', modelA], [second, '项目 B 的未发送草稿', modelB]]) {
      const draftChat = await createProjectChat(destination);
      const title = `草稿隔离 ${destination.id}`;
      const renamed = await call('conversations.rename', {id: draftChat.id, expectedVersion: draftChat.version, title});
      await selectModel(modelPicker(), selectedModel); await input().fill(draft);
      draftChats.push({chat: renamed, draft, selectedModel});
    }
    for (const {chat: draftChat, draft, selectedModel} of draftChats) {
      await row(draftChat.title).getByRole('button', {name: draftChat.title, exact: true}).click();
      await until(async () => await input().inputValue() === draft, 'conversation draft restored');
      assert.equal(await storedModelValue(modelPicker()), selectedModel, 'model selection stays with its conversation draft');
      await input().fill('');
    }
    assert.equal((await call('state.get', {})).conversations.length, 2); assert.equal(mock.requests.length, 0);
    checks.push('project menu creates empty chats; switching actual chats preserves each draft and model independently without sending a request');
    await page.getByRole('button', {name: 'Home', exact: true}).click();
    const picker = page.getByRole('combobox', {name: '所属项目', exact: true});
    assert.equal(await picker.inputValue(), '不在项目中'); await selectDropdown(picker, project.id);
    await input().fill('请生成草案'); await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await page.locator('.workspace.projects').waitFor();
    const chat = (await call('state.get', {})).conversations.find(chat => chat.title === '请生成草案'); assert.equal(chat.projectId, project.id); await complete(chat.id);
    await page.getByRole('button', {name: '应用到月历', exact: true}).waitFor();
    const messages = await call('conversations.history', {id: chat.id});
    assert.equal(await group(project.id).getByRole('button', {name: chat.title, exact: true}).count(), 1, 'Home chat is nested under its project');
    assert.equal(await select(project.name).getAttribute('aria-current'), null);
    const toggle = select(project.name);
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await row(chat.title).waitFor({state: 'hidden'});
    await toggle.click(); await row(chat.title).waitFor(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await select(longName).click();
    assert.equal(await row(chat.title).getByRole('button', {name: chat.title, exact: true}).getAttribute('aria-current'), 'page', 'disclosure keeps the active chat');
    assert.equal(await page.getByRole('button', {name: '应用到月历', exact: true}).count(), 1, 'disclosure does not clear the active reply');
    const secondChat = await createProjectChat(second);
    assert.equal(await group(second.id).getByRole('button', {name: secondChat.title, exact: true}).count(), 1);
    await group(project.id).getByRole('button', {name: chat.title, exact: true}).click();
    await compactChat();
    checks.push('Home chat opens under its project; full group rows collapse and expand without navigation; project menu creates a chat in that project');

    const longTitle = '这是一条用于验证项目树单行省略及完整悬浮提示的聊天标题';
    await (await menu('聊天', chat.title, '改名')).click();
    dialog = page.getByRole('dialog', {name: '聊天改名', exact: true}); await dialog.getByLabel('聊天名称', {exact: true}).fill(longTitle);
    await dialog.getByRole('button', {name: '保存', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
    await row(longTitle).getByRole('button', {name: longTitle, exact: true}).hover();
    await page.getByRole('tooltip').filter({hasText: longTitle}).waitFor();
    for (const destination of [second, project]) {
      await (await menu('聊天', longTitle, '移动')).click();
      dialog = page.getByRole('dialog', {name: '移动聊天', exact: true});
      await selectDropdown(dialog.getByRole('combobox', {name: '所属项目', exact: true}), destination.id);
      await dialog.getByRole('button', {name: '保存', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
      await group(destination.id).getByRole('button', {name: longTitle, exact: true}).waitFor();
      assert.equal(await select(destination.name).getAttribute('aria-current'), null);
      assert.equal(await row(longTitle).getByRole('button', {name: longTitle, exact: true}).getAttribute('aria-current'), 'page');
      assert.deepEqual(await call('conversations.history', {id: chat.id}), messages);
    }
    checks.push('chat menu renames and moves between project groups, keeps active project aligned, preserves history, and exposes full long title in tooltip');

    const unsent = '归档后恢复的未发送草稿'; await input().fill(unsent);
    await (await menu('聊天', longTitle, '归档')).click();
    await until(async () => !!(await call('state.get', {})).conversations.find(c => c.id === chat.id).archived, 'chat archive committed');
    await until(async () => await input().inputValue() === '', 'archive navigation resets composer');
    assert.equal(await row(longTitle).count(), 0);
    assert.equal(await categories().locator('.conversation-row.selected').count(), 0);
    assert.equal(await input().inputValue(), '', 'archive returns to a fresh composer');
    assert.equal(await page.getByRole('button', {name: '应用到月历', exact: true}).count(), 0);
    assert.equal(await page.getByRole('button', {name: '编辑 / 验证 JSON', exact: true}).count(), 0);
    assert.equal(await page.locator('.archived-chats, .archived-chat-notice').count(), 0);
    assert.deepEqual(await call('conversations.history', {id: chat.id}), messages);
    await screenshot('archived-chat.png');
    const archived = (await call('state.get', {})).conversations.find(c => c.id === chat.id);
    await call('conversations.archive', {id: archived.id, expectedVersion: archived.version, archived: false});
    await row(longTitle).getByRole('button', {name: longTitle, exact: true}).click();
    await input().waitFor(); await until(async () => await input().inputValue() === unsent, 'restored chat recovers unsent draft');
    assert.equal(await input().inputValue(), unsent);
    assert.deepEqual(await call('conversations.history', {id: chat.id}), messages);
    checks.push('archived chat disappears without an archive panel; history and unsent draft remain intact and restoration returns the same conversation');

    await page.getByRole('button', {name: 'Home', exact: true}).click(); await selectDropdown(picker, '');
    await input().fill('慢回复测试'); await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await page.locator('.workspace.projects').waitFor();
    const unassigned = (await call('state.get', {})).conversations.find(c => c.title === '慢回复测试');
    assert.equal(unassigned.projectId, null);
    assert.equal(await group(null).getByRole('button', {name: unassigned.title, exact: true}).count(), 1);
    assert.equal(await (await menu('聊天', unassigned.title, '归档')).isDisabled(), true); await page.keyboard.press('Escape');
    const active = (await call('state.get', {})).conversations.find(c => c.id === unassigned.id);
    const rejected = await rawCall('conversations.archive', {id: active.id, expectedVersion: active.version, archived: true});
    assert.equal(rejected.ok, false); assert.match(rejected.error.message, /生成中/);
    await page.getByRole('button', {name: '停止', exact: true}).click();
    await until(async () => !(await call('state.get', {})).conversations.find(c => c.id === unassigned.id).activeRequestId, 'request stopped');
    await page.getByRole('button', {name: '重试此轮', exact: true}).waitFor();
    await (await menu('聊天', unassigned.title, '归档')).click();
    await until(async () => !!(await call('state.get', {})).conversations.find(c => c.id === unassigned.id).archived, 'unassigned chat archive committed');
    assert.equal(await page.getByRole('button', {name: '重试此轮', exact: true}).count(), 0);
    assert.equal(await group(null).locator('.conversation-row').count(), 0);
    checks.push('unassigned chats nest in the top group; active generation disables/rejects archive; archived interrupted chat and retry disappear while projectless navigation remains');

    await (await menu('项目', longName, '归档项目')).click();
    dialog = page.getByRole('dialog', {name: '归档项目', exact: true});
    await dialog.getByRole('button', {name: '确认', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
    assert.equal(await group(second.id).count(), 0);
    const preserved = await call('state.get', {});
    assert.equal(preserved.projects.find(p => p.id === second.id).archived, true);
    assert.deepEqual(preserved.conversations.find(c => c.id === secondChat.id), secondChat);
    assert.deepEqual(preserved.tasks.find(t => t.id === linkedTask.id), linkedTask);
    assert.deepEqual(preserved.knowledge.find(k => k.id === linkedKnowledge.id), linkedKnowledge);
    assert.equal(await page.locator('.associated, .archived-chats').count(), 0);
    await row(longTitle).getByRole('button', {name: longTitle, exact: true}).click();
    checks.push('project archive hides its whole group while retaining its chats; hidden associations retain task and knowledge data');

    for (const [width, height] of [[1500, 980], [660, 980], [660, 620]]) {
      await app.evaluate(({BrowserWindow}, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height]);
      await page.waitForFunction(width => innerWidth === width, width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const layout = await page.evaluate(() => {
        const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height}; };
        return {sidebar: bounds('.project-page'), chat: bounds('.conversation-column'), composer: bounds('.composer'), viewportHeight: innerHeight};
      });
      assert.ok(layout.sidebar.width >= 150 && layout.sidebar.width <= 280, `${width}: compact project sidebar`);
      assert.ok(layout.sidebar.right <= layout.chat.left + 1 && Math.abs(layout.sidebar.top - layout.chat.top) <= 1, `${width}: project sidebar and conversation remain side by side`);
      assert.ok(layout.chat.width > layout.sidebar.width && layout.chat.height > 0, `${width}: conversation remains the main area`);
      assert.ok(layout.composer.bottom <= layout.viewportHeight + 1, `${width}x${height}: composer stays inside viewport`);
      await compactChat();
      await screenshot(`projects-${width}x${height}.png`);
    }
    checks.push('compact project tree and main conversation stay side by side at 1500x980, 660x980 and 660x620; composer remains visible without horizontal overflow or redundant chat heading/context/empty-state/destination UI, while context and new chat actions remain accessible');
    const beforeRestart = await call('state.get', {}), history = await call('conversations.history', {id: unassigned.id});
    const fixture = await app.evaluate(() => ({installedBeforeEntry: globalThis.__weatherFixture.installedBeforeEntry, ipCalls: globalThis.__weatherFixture.ipCalls, forecastCalls: globalThis.__weatherFixture.forecastCalls}));
    await app.close(); app = null;

    // Add old-format rows only to the stopped, isolated test database to exercise startup recovery.
    const SQL = await require('sql.js')({locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm')});
    const db = new SQL.Database(await fs.readFile(path.join(data, 'workday.sqlite')));
    const legacyProject = {...project, id: randomUUID(), name: '旧版归档项目', archived: true}; delete legacyProject.directory;
    const legacyChat = {...beforeRestart.conversations.find(c => c.id === chat.id), id: randomUUID(), title: '旧版聊天', projectId: legacyProject.id}; delete legacyChat.archived;
    db.run('INSERT INTO projects(id,payload) VALUES (?,?)', [legacyProject.id, JSON.stringify(legacyProject)]);
    db.run('INSERT INTO conversations(id,payload) VALUES (?,?)', [legacyChat.id, JSON.stringify(legacyChat)]);
    await fs.writeFile(path.join(data, 'workday.sqlite'), db.export()); db.close();
    await start(); const afterRestart = await call('state.get', {});
    for (const original of beforeRestart.projects) assert.deepEqual(afterRestart.projects.find(p => p.id === original.id), original);
    for (const original of beforeRestart.conversations) assert.deepEqual(afterRestart.conversations.find(c => c.id === original.id), original);
    assert.deepEqual(await call('conversations.history', {id: unassigned.id}), history);
    assert.deepEqual(afterRestart.projects.find(p => p.id === legacyProject.id), {...legacyProject, directory: null});
    assert.deepEqual(afterRestart.conversations.find(c => c.id === legacyChat.id), {...legacyChat, archived: false});
    await page.getByRole('button', {name: '项目', exact: true}).click();
    assert.equal(await group(legacyProject.id).count(), 0);
    assert.equal(await row(unassigned.title).count(), 0);
    assert.equal(await page.getByLabel('显示已归档项目', {exact: true}).count(), 0);
    await call('projects.archive', {id: legacyProject.id, expectedVersion: legacyProject.version, archived: false});
    await group(legacyProject.id).waitFor();
    await (await menu('项目', legacyProject.name, '编辑项目')).click();
    dialog = page.getByRole('dialog', {name: '编辑项目', exact: true});
    assert.equal(await dialog.getByRole('textbox', {name: /^项目文件夹/}).inputValue(), '');
    await dialog.getByLabel('项目名称', {exact: true}).fill('旧项目仍可改名');
    await dialog.getByRole('button', {name: '保存', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
    assert.equal((await call('state.get', {})).projects.find(p => p.id === legacyProject.id).directory, null);
    const stoppedChat = afterRestart.conversations.find(c => c.id === unassigned.id);
    await call('conversations.archive', {id: stoppedChat.id, expectedVersion: stoppedChat.version, archived: false});
    await group(null).getByRole('button', {name: unassigned.title, exact: true}).click();
    await page.getByRole('button', {name: '重试此轮', exact: true}).waitFor();
    assert.equal(await page.getByRole('button', {name: '重试此轮', exact: true}).count(), 1);
    assert.deepEqual(await call('conversations.history', {id: unassigned.id}), history);
    checks.push('restart preserves names, directories, archive state and history; legacy rows gain defaults; archived entries stay hidden but API restoration returns intact chats and editable legacy projects');
    assert.deepEqual(errors, []); assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every(r => !r.authorization && !JSON.stringify(r.body).includes(folder)));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({passed: true, kind, realElectron: true, executable, versions, checks, fixture, dataDirectory: data, modelRequests: mock.requests.length, modelNetwork: '127.0.0.1 controlled fixture', publicModelRequests: false, personalData: false, personalCredentials: false, nativePicker: 'showOpenDialog intercepted; openDirectory options asserted; actual native dialog validation is outside this script'}, null, 2));
    console.log(JSON.stringify({passed: true, kind, checks: checks.length, output}));
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
      await fs.writeFile(path.join(output, 'failure-aria.yml'), await page.locator('body').ariaSnapshot()).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
