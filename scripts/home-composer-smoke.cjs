const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { createMockServer } = require('./mock-model.cjs');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { selectDropdown, selectModel, storedModelValue } = require('./model-picker-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'home-composer-' + kind), output = path.join(root, 'output', 'playwright', 'home-composer', kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const mock = createMockServer();
  await new Promise((resolve, reject) => { mock.server.once('error', reject); mock.server.listen(0, '127.0.0.1', resolve); });
  const localBase = `http://127.0.0.1:${mock.server.address().port}/v1`;
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.parse(today + 'T12:00:00Z') + 2 * 86400000).toISOString().slice(0, 10);
  const checks = [], errors = []; let app, page;
  async function call(op, payload) {
    const result = await page.evaluate(({ op, payload }) => window.workday.call(op, payload), { op, payload });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  async function until(predicate, description) {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + description);
  }
  const input = () => page.getByRole('textbox', { name: '消息输入', exact: true });
  const project = () => page.getByRole('combobox', { name: '所属项目', exact: true });
  const model = () => page.getByRole('combobox', { name: '选择模型与模型源', exact: true });
  async function home() { await page.getByRole('button', { name: 'Home', exact: true }).click(); await page.getByRole('region', { name: '新聊天', exact: true }).waitFor(); }
  async function context() { await page.getByRole('button', { name: /^添加上下文/ }).click(); const dialog = page.getByRole('dialog', { name: '选择本次对话上下文' }); await dialog.waitFor(); return dialog; }
  async function composerGeometry() {
    const layout = await page.locator('.composer').evaluate(composer => {
      const textarea = composer.querySelector('textarea[aria-label="消息输入"]'), footer = composer.querySelector('.composer-footer');
      const surface = composer.querySelector('.composer-input').getBoundingClientRect(), row = footer.getBoundingClientRect();
      const controls = [...footer.querySelectorAll('select, button, .mantine-Select-input')].map(control => {
        const box = control.getBoundingClientRect();
        return { left: box.left, right: box.right, center: box.top + box.height / 2 };
      });
      const selects = [...composer.querySelectorAll('select, .mantine-Select-input')].map(select => {
        const style = getComputedStyle(select);
        return { content: parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), height: select.clientHeight };
      });
      return { resize: getComputedStyle(textarea).resize, surface: { left: surface.left, right: surface.right, bottom: surface.bottom }, row: { left: row.left, right: row.right, bottom: row.bottom, center: row.top + row.height / 2 }, overflow: footer.scrollWidth > footer.clientWidth + 1, controls, selects };
    });
    assert.equal(layout.resize, 'none', 'composer has no native resize grip');
    assert.equal(layout.overflow, false, 'toolbar fits the composer');
    assert.ok(layout.row.left >= layout.surface.left && layout.row.right <= layout.surface.right && layout.row.bottom <= layout.surface.bottom);
    for (const control of layout.controls) {
      assert.ok(control.left >= layout.row.left - 1 && control.right <= layout.row.right + 1, 'toolbar controls stay within the row');
      assert.ok(Math.abs(control.center - layout.row.center) <= 1, 'toolbar controls align vertically');
    }
    for (const select of layout.selects) assert.ok(select.content <= select.height + 1, 'select text fits vertically');
  }
  async function composerAutosize() {
    const draft = await input().inputValue();
    await input().fill('单行草稿');
    const shortHeight = (await input().boundingBox()).height;
    await input().press('Enter');
    assert.equal(await input().inputValue(), '单行草稿\n', 'plain Enter keeps a newline without sending');
    await input().fill(Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 行草稿`).join('\n'));
    await until(async () => (await input().boundingBox()).height > shortHeight + 40, 'composer grows with multiline text');
    await composerGeometry();
    await input().fill('单行草稿');
    await until(async () => Math.abs((await input().boundingBox()).height - shortHeight) <= 1, 'composer shrinks after clearing lines');
    await input().fill(draft);
  }
  async function completed(id) {
    await until(async () => {
      const conversation = (await call('state.get', {})).conversations.find(c => c.id === id);
      return !conversation.activeRequestId && (await call('conversations.history', { id })).some(m => m.role === 'assistant' && m.status === 'complete');
    }, 'assistant committed for ' + id);
  }
  const systemText = () => mock.requests.at(-1).body.messages.find(message => message.role === 'system').content;
  const calendarTasks = (text = systemText()) => JSON.parse(text.match(/Calendar tasks for [^\n]+\n(\[[^\n]*\])/)[1]);
  async function day(date, count) {
    await page.locator(`.day[aria-label^="${date}"]`).click();
    await until(async () => (await page.locator('.composer-calendar').getAttribute('aria-label'))?.startsWith(`${date} · 自动携带当天全部 ${count} 项待办`), 'selected date and task count shown');
  }
  async function sendExisting(text, id) {
    const before = mock.requests.length;
    await input().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await until(async () => mock.requests.length === before + 1, 'new request sent'); await completed(id);
  }
  async function sendNew(text, projectId, expectedDate = today) {
    const before = new Set((await call('state.get', {})).conversations.map(c => c.id));
    await input().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('.workspace.projects').waitFor();
    const created = (await call('state.get', {})).conversations.filter(c => !before.has(c.id));
    assert.equal(created.length, 1); assert.equal(created[0].projectId, projectId); assert.equal(created[0].context.date, expectedDate); assert.equal(created[0].context.calendarTasks, true);
    await completed(created[0].id); return created[0];
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'packaged' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const versions = await app.evaluate(() => ({ ...process.versions })), executable = await app.evaluate(() => process.execPath);
    assert.equal(await input().count(), 1); assert.equal(await project().inputValue(), '不在项目中');
    assert.doesNotMatch(await page.locator('.conversation-column').textContent(), /逾期|AI 对话|从一个问题开始|给今天留一点方向/);
    assert.equal(await page.locator('.new-chat .chat-heading,.new-chat .chat-context,.new-chat .destination,.new-chat .messages').count(), 0);
    await page.getByRole('img', { name: '暂无待办', exact: true }).waitFor();
    assert.equal(await page.locator('.day-empty').textContent(), '');
    assert.equal(await page.getByRole('button', { name: '配置模型源', exact: true }).count(), 1);
    checks.push('Home has one compact new-chat composer, optional project, and no overdue controls or chat introduction');

    const folderA = path.join(data, 'project-a'), folderB = path.join(data, 'project-b');
    await fs.mkdir(folderA); await fs.mkdir(folderB);
    const a = await call('projects.save', { name: '产品计划', description: '本地回归项目 A', directory: folderA });
    const b = await call('projects.save', { name: '临时研究', description: '本地回归项目 B', directory: folderB });
    await call('tasks.save', { title: '今天的待办', notes: '', date: today, projectId: null, completed: false });
    let rolled = await call('tasks.save', { title: '前一天的待办', notes: '', date: yesterday, projectId: null, completed: false });
    assert.equal(rolled.date, today, 'past unfinished task moves to today');
    await call('tasks.save', { title: '前一天的完成记录', notes: '', date: yesterday, projectId: null, completed: true });
    await page.locator('.day-panel').getByRole('checkbox', { name: '完成 今天的待办', exact: true }).waitFor();
    await page.locator('.day-panel').getByRole('checkbox', { name: '完成 前一天的待办', exact: true }).waitFor();
    assert.equal(await page.locator('.day-panel .task-row').count(), 2);
    await page.getByRole('checkbox', { name: '完成 今天的待办', exact: true }).click();
    await until(async () => await page.getByRole('checkbox', { name: '完成 今天的待办', exact: true }).isChecked(), 'task completed');
    await page.getByRole('checkbox', { name: '完成 今天的待办', exact: true }).click();
    await until(async () => !(await page.getByRole('checkbox', { name: '完成 今天的待办', exact: true }).isChecked()), 'task reopened');
    assert.equal(await page.locator('.day-panel .undo').count(), 0);
    assert.equal(await page.locator('.day-panel').getByRole('button', { name: '撤销', exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.day-panel').textContent(), /待办已更新/);
    await page.locator(`.day[aria-label^="${yesterday}"]`).click();
    await page.locator('.day-panel').getByRole('checkbox', { name: '完成 前一天的完成记录', exact: true }).waitFor();
    assert.equal(await page.locator('.day-panel .task-row').count(), 1);
    assert.equal(await page.locator('.day-panel').getByRole('checkbox', { name: '完成 前一天的完成记录', exact: true }).isChecked(), true);
    assert.equal(await page.locator('.day-panel').getByRole('checkbox', { name: '完成 前一天的待办', exact: true }).count(), 0);
    checks.push('past pending tasks move to today while yesterday retains only completed records; selected-day filtering and completion/reopening work without an update/undo bar');

    const source = await call('sources.save', { name: '本地模拟', baseUrl: localBase, models: [{ id: 'workday-mock', name: '模拟模型', supportsTools: false }, { id: 'selection-only', name: '模型 B（仅选择）', supportsTools: false }] });
    await call('settings.defaultModel', { model: { sourceId: source.id, modelId: 'workday-mock' } });
    const mockModel = JSON.stringify([source.id, 'workday-mock']), modelB = JSON.stringify([source.id, 'selection-only']);
    await composerGeometry(); await composerAutosize();
    checks.push('Home composer keeps text and controls aligned, removes manual resize, and grows/shrinks with multiline input');
    await selectModel(model(), modelB);
    const draft = '保留这一段尚未发送的问题';
    await input().fill(draft); await page.getByRole('button', { name: '设置', exact: true }).click(); await home();
    await until(async () => (await input().inputValue()) === draft, 'draft restored after settings');
    assert.equal(await storedModelValue(model()), modelB); await selectModel(model(), mockModel);
    let taskA = await call('tasks.save', { title: '项目 A 的当天任务', notes: '初始备注 A', date: today, projectId: a.id, completed: false });
    const taskB = await call('tasks.save', { title: '项目 B 的完成记录', notes: '已完成备注 B', date: today, projectId: b.id, completed: true });
    const deleted = await call('tasks.save', { title: '已删除的任务哨兵', notes: '', date: today, projectId: null, completed: false });
    await call('tasks.delete', { id: deleted.id, expectedVersion: deleted.version });
    await call('tasks.save', { title: '其他日期任务哨兵', notes: '', date: later, projectId: a.id, completed: false });
    const knowledge = await call('knowledge.save', { name: '手动参考资料', content: '手动资料保留哨兵', projectId: null });
    const skill = await call('skills.save', { name: '手动能力', description: '本地测试', content: '手动 Skill 保留哨兵' });
    await day(today, 4); assert.equal(await input().inputValue(), draft);
    let dialog = await context();
    assert.equal(await dialog.getByLabel('日期上下文（月历选择）', { exact: true }).inputValue(), today);
    assert.equal(await dialog.getByLabel('日期上下文（月历选择）', { exact: true }).getAttribute('readonly'), '');
    assert.equal(await dialog.getByRole('checkbox', { name: /项目 A 的当天任务|项目 B 的完成记录/ }).count(), 0, 'manual task choices remain project scoped');
    await dialog.getByRole('checkbox', { name: /今天的待办/ }).check();
    await dialog.getByRole('checkbox', { name: /手动参考资料/ }).check();
    await dialog.getByLabel('Skill（一次选择一个）', { exact: true }).selectOption(skill.id);
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await selectModel(model(), modelB); await day(yesterday, 1); assert.equal(await input().inputValue(), draft); assert.equal(await storedModelValue(model()), modelB);
    dialog = await context();
    assert.equal(await dialog.getByRole('checkbox', { name: /手动参考资料/ }).isChecked(), true);
    assert.equal(await dialog.getByLabel('Skill（一次选择一个）', { exact: true }).inputValue(), skill.id);
    assert.equal(await dialog.locator('details').first().getByRole('checkbox', { checked: true }).count(), 0, 'old-day manual task choice cleared');
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await day(today, 4); await selectModel(model(), mockModel);
    dialog = await context();
    assert.equal(await dialog.getByRole('checkbox', { name: /今天的待办/ }).isChecked(), false, 'returning to day does not revive old manual task selection');
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '设置', exact: true }).click(); await home();
    assert.equal(await input().inputValue(), draft);
    dialog = await context(); assert.equal(await dialog.getByRole('checkbox', { name: /手动参考资料/ }).isChecked(), true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    checks.push('Home calendar date is readonly; date switches preserve draft/model/knowledge/Skill, clear old-day manual task choices, and return Home preserves selections');

    const unassigned = await sendNew(draft, null);
    await composerGeometry(); await composerAutosize();
    assert.equal(await page.locator('.chat-heading,.chat-context,.composer .destination').count(), 0);
    assert.equal(await page.getByRole('button', { name: /^(展开|收起)对话区$/ }).count(), 0);
    checks.push('existing-chat composer uses the same fitted toolbar and automatic textarea height without a redundant heading, context row or destination line');
    assert.equal(await page.locator('.project-group[data-project-id="none"] .conversation-row.selected').count(), 1);
    assert.equal((await call('conversations.history', { id: unassigned.id })).filter(m => m.role === 'user').length, 1);
    assert.equal(calendarTasks().length, 4);
    assert.equal(calendarTasks().find(task => task.id === taskB.id).completed, true);
    assert.equal(calendarTasks().find(task => task.id === taskA.id).notes, '初始备注 A');
    assert.deepEqual(new Set(calendarTasks().map(task => task.projectId)), new Set([null, a.id, b.id]));
    assert.doesNotMatch(systemText(), /已删除的任务哨兵|其他日期任务哨兵|前一天的完成记录/);
    assert.match(systemText(), /手动资料保留哨兵/); assert.match(systemText(), /手动 Skill 保留哨兵/);
    assert.match(systemText(), /Current projectId: null\./);
    const oldDraft = '只属于旧会话的未发送草稿';
    await input().fill(oldDraft); await selectModel(model(), modelB); await home(); await day(yesterday, 1);
    assert.equal(await input().inputValue(), ''); assert.equal(await project().inputValue(), '不在项目中');
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await until(async () => (await input().inputValue()) === oldDraft, 'existing conversation draft restored');
    assert.equal(await storedModelValue(model()), modelB);
    await selectModel(model(), mockModel);
    dialog = await context();
    const existingDate = dialog.getByLabel('日期上下文（可清除）', { exact: true });
    assert.equal(await existingDate.inputValue(), today, 'existing chat keeps its day while Home selects another day');
    assert.equal(await existingDate.getAttribute('type'), 'date');
    await existingDate.fill('');
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    let savedContext = (await call('state.get', {})).conversations.find(c => c.id === unassigned.id).context;
    assert.equal(savedContext.date, null); assert.equal(savedContext.calendarTasks, false); assert.deepEqual(savedContext.taskIds, []);
    dialog = await context(); assert.equal(await dialog.getByLabel('日期上下文（可清除）', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByRole('checkbox', { name: /手动参考资料/ }).isChecked(), true);
    assert.equal(await dialog.getByLabel('Skill（一次选择一个）', { exact: true }).inputValue(), skill.id);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await sendExisting('清除日期后只讨论手动资料', unassigned.id);
    assert.doesNotMatch(systemText(), /Selected date:|Calendar tasks for/);
    assert.match(systemText(), /手动资料保留哨兵/); assert.match(systemText(), /手动 Skill 保留哨兵/);
    assert.equal((await call('state.get', {})).conversations.find(c => c.id === unassigned.id).context.calendarTasks, false);
    await home(); await day(today, 4);
    checks.push('actual request includes all selected-day projects/completed tasks and manual references, excludes deleted/other-day tasks; existing chat keeps its day, and composer context editor persists date clearing while retaining knowledge/Skill');

    dialog = await context();
    await dialog.getByRole('checkbox', { name: /今天的待办/ }).check();
    await dialog.getByRole('checkbox', { name: /手动参考资料/ }).check();
    await dialog.getByLabel('Skill（一次选择一个）', { exact: true }).selectOption(skill.id);
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await input().fill(draft); await selectDropdown(project(), a.id); assert.equal(await input().inputValue(), draft);
    dialog = await context(); assert.equal(await dialog.getByLabel('日期上下文（月历选择）', { exact: true }).inputValue(), today);
    assert.equal(await dialog.locator('input[type="checkbox"]:checked').count(), 0);
    assert.equal(await dialog.getByLabel('Skill（一次选择一个）', { exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await selectDropdown(project(), b.id); assert.equal(await input().inputValue(), draft);
    await selectDropdown(project(), a.id); assert.equal(await input().inputValue(), draft);
    taskA = await call('tasks.save', { id: taskA.id, expectedVersion: taskA.version, title: '项目 A 的更新任务', notes: '最新备注 A', date: today, projectId: a.id, completed: true });
    await call('tasks.delete', { id: rolled.id, expectedVersion: rolled.version });
    const added = await call('tasks.save', { title: '刚刚新增的任务', notes: '新任务备注', date: today, projectId: null, completed: false });
    await day(today, 4);
    const assigned = await sendNew('项目内的新问题', a.id);
    assert.notEqual(assigned.id, unassigned.id);
    assert.equal(await page.locator(`.project-group[data-project-id="${a.id}"] .conversation-row.selected`).count(), 1);
    assert.ok(systemText().includes(`Current projectId: "${a.id}".`));
    assert.equal(calendarTasks().find(task => task.id === taskA.id).title, '项目 A 的更新任务');
    assert.equal(calendarTasks().find(task => task.id === taskA.id).notes, '最新备注 A');
    assert.equal(calendarTasks().find(task => task.id === taskA.id).completed, true);
    assert.ok(calendarTasks().some(task => task.id === added.id)); assert.ok(!calendarTasks().some(task => task.id === rolled.id));
    assert.doesNotMatch(systemText(), /手动资料保留哨兵|手动 Skill 保留哨兵/);
    checks.push('project switches clear manual scope but retain automatic date and draft; newly edited/completed/added/deleted tasks reach the next real request');

    dialog = await context();
    await dialog.getByLabel('日期上下文（可清除）', { exact: true }).fill(tomorrow);
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    savedContext = (await call('state.get', {})).conversations.find(c => c.id === assigned.id).context;
    assert.equal(savedContext.date, tomorrow); assert.equal(savedContext.calendarTasks, true);
    dialog = await context();
    assert.equal(await dialog.getByLabel('日期上下文（可清除）', { exact: true }).inputValue(), tomorrow, 'changed date persists when context editor is reopened');
    await dialog.getByLabel('日期上下文（可清除）', { exact: true }).fill('');
    await dialog.getByRole('button', { name: '保存选择', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await call('state.get', {})).conversations.find(c => c.id === assigned.id).context.date, null);
    await sendExisting('日期编辑器已清空', assigned.id);
    assert.doesNotMatch(systemText(), /Selected date:|Calendar tasks for/);
    assert.equal((await call('state.get', {})).conversations.find(c => c.id === assigned.id).context.calendarTasks, false);
    await home(); await day(tomorrow, 0); await selectDropdown(project(), '');
    await sendNew('看看空白的一天', null, tomorrow);
    assert.deepEqual(calendarTasks(), []); assert.match(systemText(), /There are no tasks on the selected date/);
    checks.push('composer context editor persists date changes and clearing disables auto context; an empty selected day sends an explicit empty list');
    await page.screenshot({ path: path.join(output, 'project-chat.png') });


    await home(); await day(yesterday, 1); assert.equal(await input().inputValue(), ''); await selectDropdown(project(), '');
    // Reject only one test-process IPC call; the production bridge and handler are restored before retry.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('workday:call');
      if (typeof original !== 'function') throw new Error('Missing existing IPC handler');
      ipcMain._invokeHandlers.set('workday:call', (event, operation, payload) => {
        if (operation !== 'chat.send') return original(event, operation, payload);
        ipcMain._invokeHandlers.set('workday:call', original); globalThis.__homeRejectedOnce = true;
        return { ok: false, error: { code: 'TEST_REJECTED', message: '本地首发拒绝测试' } };
      });
    });
    const beforeRejected = new Set((await call('state.get', {})).conversations.map(c => c.id)), rejectedText = '发送拒绝后保留的问题';
    await input().fill(rejectedText); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('alert').getByText(/本地首发拒绝测试/).waitFor(); await page.locator('.workspace.projects').waitFor();
    assert.equal(await input().inputValue(), rejectedText);
    const rejected = (await call('state.get', {})).conversations.filter(c => !beforeRejected.has(c.id));
    assert.equal(rejected.length, 1); assert.equal(rejected[0].context.date, yesterday); assert.equal(rejected[0].context.calendarTasks, true);
    assert.equal((await call('conversations.history', { id: rejected[0].id })).length, 0);
    await home(); await day(today, 4); await page.getByRole('button', { name: '项目', exact: true }).click();
    assert.equal(await input().inputValue(), rejectedText);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    dialog = await context(); assert.equal(await dialog.getByLabel('日期上下文（可清除）', { exact: true }).inputValue(), yesterday);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '发送消息', exact: true }).click(); await completed(rejected[0].id);
    assert.equal((await call('conversations.history', { id: rejected[0].id })).filter(m => m.role === 'user').length, 1);
    assert.equal((await call('state.get', {})).conversations.length, beforeRejected.size + 1);
    assert.equal(await app.evaluate(() => globalThis.__homeRejectedOnce), true);
    assert.match(systemText(), new RegExp('Selected date: ' + yesterday));
    assert.deepEqual(calendarTasks().map(task => task.title), ['前一天的完成记录']);
    checks.push('first-send rejection persists selected day/auto mode and draft; changing Home day does not affect retry in the created conversation');

    await home();
    await until(async () => (await input().inputValue()) === '', 'Home draft cleared after rejected first-send retry');
    for (const [theme, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('tab', { name: '主题', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click(); await home();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const width of [1500, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const composer = await page.locator('.new-chat').boundingBox();
        assert.ok(composer.width > 200 && composer.x + composer.width <= width + 1);
        await composerGeometry();
        if (width === 660) await page.locator('.new-chat').scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0); await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        await page.locator('.composer').screenshot({ path: path.join(output, `${theme}-${width}-composer.png`), animations: 'disabled' });
      }
    }
    checks.push('three themes at 1500 and 660 pixels keep the compact composer within the window');
    assert.deepEqual(errors, []); assert.equal(mock.requests.length, 6); assert.ok(mock.requests.every(r => !r.authorization));
    const fixture = await app.evaluate(() => ({ installedBeforeEntry: globalThis.__weatherFixture.installedBeforeEntry, ipCalls: globalThis.__weatherFixture.ipCalls, forecastCalls: globalThis.__weatherFixture.forecastCalls }));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, realElectron: true, executable, versions, checks, fixture, dataDirectory: data, modelRequests: mock.requests.length, requestEvidence: mock.requests.map(request => ({ system: request.body.messages[0].content, user: request.body.messages.filter(message => message.role === 'user').at(-1).content })), modelNetwork: '127.0.0.1 controlled HTTP fixture', weatherAndHolidays: 'fixtures installed before main entry', actualPublicModelNetwork: false, personalData: false, personalCredentials: false }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(output, 'failure-aria.yml'), await page.locator('body').ariaSnapshot()).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
