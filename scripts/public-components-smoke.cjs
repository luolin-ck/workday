const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { selectDropdown, selectModel } = require('./model-picker-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'output', 'playwright', 'public-components');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-public-components-'));
  const projectDirectory = path.join(data, 'component-project'); await fs.mkdir(projectDirectory);
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [], themeEvidence = [];
  function record(message) { checks.push(message); console.log(JSON.stringify({check: checks.length, message})); }
  let app, page, taskFixture;
  async function until(check, label) {
    for (let n = 0; n < 120; n++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out: ' + label);
  }
  const call = async (op, input) => {
    const result = await page.evaluate(({op, input}) => window.workday.call(op, input), {op, input});
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const count = op => app.evaluate((_, op) => globalThis.__componentFixture.calls[op] || 0, op);
  const dialog = name => page.getByRole('dialog', {name, exact: true});
  const nav = name => page.getByRole('navigation', {name: '全局导航'}).getByRole('button', {name, exact: true});
  async function openTask() {
    const task = (await call('state.get', {})).tasks.find(t => t.id === taskFixture.id);
    assert.ok(task, 'isolated modal task must remain available');
    await page.getByRole('button', {name: `编辑与改期 ${task.title}`, exact: true}).focus(); await page.keyboard.press('Enter');
    await dialog('编辑待办').waitFor(); return dialog('编辑待办');
  }
  async function closeWithEscape(modal) {
    await page.keyboard.press('Escape'); await modal.waitFor({state: 'hidden'});
  }
  async function checkModalLayout(modal, screenshot, requireScroll = false) {
    const body = modal.locator('.modal-body');
    await body.evaluate(el => { el.scrollTop = 0; });
    const geometry = () => modal.evaluate(el => {
      const body = el.querySelector('.modal-body');
      const rect = node => { const r = node.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; };
      return {
        viewport: {width: innerWidth, height: innerHeight},
        modal: rect(el), title: rect(el.querySelector('.mantine-Modal-title')),
        header: rect(el.querySelector('.modal-header')), footer: rect(el.querySelector('.modal-footer')),
        horizontalOverflow: el.scrollWidth > el.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1,
        scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight
      };
    });
    const before = await geometry();
    assert.equal(before.horizontalOverflow, false, 'dialog and body must not overflow horizontally');
    for (const part of ['modal', 'title', 'header', 'footer']) {
      const rect = before[part];
      assert.ok(rect.top >= 0 && rect.bottom <= before.viewport.height + 1, `${part} must stay inside the viewport`);
      assert.ok(rect.left >= 0 && rect.right <= before.viewport.width + 1, `${part} must fit the viewport width`);
    }
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const after = await geometry();
    assert.ok(after.scrollTop + after.clientHeight >= after.scrollHeight - 1, 'dialog body must scroll to its final content');
    if (requireScroll) assert.ok(after.scrollTop > 0, 'long dialog must scroll within its body');
    for (const part of ['title', 'header', 'footer']) {
      assert.ok(Math.abs(after[part].top - before[part].top) <= 1, `${part} must stay fixed while body scrolls`);
      assert.ok(Math.abs(after[part].bottom - before[part].bottom) <= 1, `${part} must remain fully visible while body scrolls`);
    }
    await page.mouse.move(0, 0);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].showInactive());
    try { await modal.screenshot({path: path.join(output, screenshot)}); }
    finally { await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].hide()); }
  }
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, {mockHolidays: true});
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Keep isolated keyboard checks from stealing desktop input.
    await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.hide();
    });
    await nav('Home').waitFor();
    taskFixture = await call('tasks.save', {
      title: '组件弹窗测试待办', notes: '',
      date: new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date()),
      dueDate: null, projectId: null, completed: false
    });
    await app.evaluate(({ipcMain}) => {
      // Intercept only this isolated process; the production preload and renderer stay unchanged.
      const original = ipcMain._invokeHandlers.get('workday:call');
      if (!original) throw new Error('Missing production IPC handler');
      const fixture = globalThis.__componentFixture = {calls: {}, mode: 'normal', virtualMcp: false, activeChat: null, blocked: []};
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, operation, payload) => {
        fixture.calls[operation] = (fixture.calls[operation] || 0) + 1;
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.discover', 'mcp.call', 'mcp.readResource', 'schedules.run'].includes(operation)) {
          fixture.blocked.push(operation); return {ok: false, error: {code: 'TEST_BLOCKED', message: 'External operations disabled in component test'}};
        }
        if (operation === 'grants.save') return {ok: false, error: {code: 'TEST_GRANT', message: '只读授权测试已截获，未连接服务'}};
        if (operation === 'tasks.save') {
          if (fixture.mode === 'hold') await new Promise(resolve => { fixture.release = resolve; });
          if (fixture.mode === 'fail') return {ok: false, error: {code: 'TEST_SAVE', message: '隔离保存失败，请重试'}};
        }
        const result = await original(event, operation, payload);
        if (operation === 'state.get' && result.ok) {
          if (fixture.activeChat) result.value.conversations = result.value.conversations.map(c => c.id === fixture.activeChat ? {...c, activeRequestId: 'fixture-active-request'} : c);
          if (fixture.virtualMcp) result.value.mcpServers = [{
            id: 'fixture-mcp', version: 1, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
            name: '隔离只读组件测试', transport: 'http', command: '', args: [], url: 'http://127.0.0.1:1/never-called',
            enabled: true, ownerPluginId: null, configVersion: 1, credentialConfigured: false,
            tools: [{name: 'fixture_read', description: '不连接服务，仅验证授权表单', inputSchema: {type: 'object', properties: {}, additionalProperties: false}}],
            resources: [], prompts: [], discoveredAt: '2026-10-14T00:00:00Z'
          }];
        }
        return result;
      });
    });

    let modal = await openTask();
    const content = modal.getByLabel('内容', {exact: true});
    await until(() => content.evaluate(el => el === document.activeElement), 'task input initial focus');
    const closeGeometry = await modal.getByRole('button', {name: '关闭对话框', exact: true}).evaluate(el => ({button: el.getBoundingClientRect().width, icon: el.querySelector('svg')?.getBoundingClientRect().width}));
    assert.ok(closeGeometry.button >= 28 && closeGeometry.icon >= 14, 'close action and SVG must have usable visible size');
    await content.fill('');
    await modal.getByRole('button', {name: '保存', exact: true}).click();
    assert.equal(await count('tasks.save'), 0);
    assert.equal(await content.evaluate(el => el.validity.valueMissing), true);
    assert.equal(await modal.isVisible(), true);
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await modal.evaluate(el => el.contains(document.activeElement)), true, 'focus must remain inside modal');
    }
    await closeWithEscape(modal);
    await until(() => page.getByRole('button', {name: `编辑与改期 ${taskFixture.title}`, exact: true}).evaluate(el => el === document.activeElement), 'focus returns to opening button');
    modal = await openTask();
    await page.mouse.click(5, 100); await modal.waitFor({state: 'hidden'});
    record('Modal keeps initial focus and Tab focus trap, native required validation, Escape/backdrop close and focus return');

    modal = await openTask();
    await modal.getByLabel('内容', {exact: true}).fill('Enter 保存一次');
    await modal.getByLabel('内容', {exact: true}).press('Enter');
    await modal.waitFor({state: 'hidden'});
    assert.equal(await count('tasks.save'), 1);
    assert.equal((await call('state.get', {})).tasks.filter(t => t.title === 'Enter 保存一次').length, 1);
    assert.equal((await call('state.get', {})).tasks.length, 1);
    record('Enter submits a valid edit form exactly once and updates the single isolated task');

    modal = await openTask();
    await modal.getByLabel('内容', {exact: true}).fill('忙碌中仅保存一次');
    await app.evaluate(() => { globalThis.__componentFixture.mode = 'hold'; });
    await modal.getByRole('button', {name: '保存', exact: true}).click();
    await until(async () => await count('tasks.save') === 2, 'delayed save starts');
    assert.equal(await modal.getByRole('button', {name: '关闭对话框', exact: true}).isDisabled(), true);
    assert.equal(await modal.getByRole('button', {name: '取消', exact: true}).isDisabled(), true);
    assert.equal(await modal.locator('button[type="submit"]').isDisabled(), true);
    await page.keyboard.press('Escape'); await page.mouse.click(5, 100);
    await modal.getByLabel('内容', {exact: true}).press('Enter');
    // requestSubmit exercises the synchronous lock even if a second event reaches the form before paint.
    await modal.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    assert.equal(await modal.isVisible(), true); assert.equal(await count('tasks.save'), 2);
    await app.evaluate(() => { globalThis.__componentFixture.mode = 'normal'; globalThis.__componentFixture.release(); });
    await modal.waitFor({state: 'hidden'});
    assert.equal((await call('state.get', {})).tasks.filter(t => t.title === '忙碌中仅保存一次').length, 1);
    record('Busy save disables close/cancel/submit, rejects Escape/backdrop, and locks Enter/repeated submit events to one RPC');

    modal = await openTask(); await modal.getByLabel('内容', {exact: true}).fill('失败保留后重试');
    await app.evaluate(() => { globalThis.__componentFixture.mode = 'fail'; });
    await modal.getByRole('button', {name: '保存', exact: true}).click();
    await modal.getByRole('alert').waitFor();
    assert.match(await modal.getByRole('alert').textContent(), /隔离保存失败，请重试/);
    assert.equal(await modal.getByLabel('内容', {exact: true}).inputValue(), '失败保留后重试');
    assert.equal(await modal.getByRole('button', {name: '保存', exact: true}).isEnabled(), true);
    await app.evaluate(() => { globalThis.__componentFixture.mode = 'normal'; });
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    assert.equal(await count('tasks.save'), 4);
    record('Failed save keeps the dialog, error and entered values; the same form can retry successfully');

    await nav('设置').click();
    const modelTab = page.getByRole('tab', {name: '模型源', exact: true});
    await modelTab.focus(); await page.keyboard.press('ArrowRight');
    await until(() => page.getByRole('tab', {name: '主题', exact: true}).evaluate(el => el.getAttribute('aria-selected') === 'true'), 'keyboard switches settings tab');
    assert.equal(await page.getByRole('tabpanel', {name: '主题', exact: true}).isVisible(), true);
    assert.equal(await page.getByRole('tabpanel', {name: '模型源', exact: true}).count(), 0);
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('button', {name: '添加', exact: true}).click(); modal = dialog('添加模型源');
    await modal.getByLabel('源名称', {exact: true}).fill('仅表单测试');
    await modal.getByLabel('Base URL', {exact: true}).fill('http://127.0.0.1:1/v1');
    const addModel = modal.getByRole('button', {name: '手动添加', exact: true});
    assert.equal(await addModel.getAttribute('type'), 'button'); await addModel.click();
    await modal.getByRole('textbox', {name: '模型 1 名称', exact: true}).fill('本地表单');
    await modal.getByRole('textbox', {name: '模型 1 ID', exact: true}).fill('fixture');
    await checkModalLayout(modal, 'modal-source-manual-model.png');
    const originalWindowSize = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getSize());
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(660, 620));
    await page.waitForFunction(() => innerWidth === 660);
    await checkModalLayout(modal, 'modal-source-manual-model-660.png');
    await app.evaluate(({BrowserWindow}, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), originalWindowSize);
    await page.waitForFunction(width => innerWidth === width, originalWindowSize[0]);
    await modal.getByRole('button', {name: '移除模型 1', exact: true}).click();
    assert.equal(await count('sources.save'), 0);
    await modal.getByRole('button', {name: '取消', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    record('Settings Tabs support arrow navigation and matching visible panels; manual-add/remove/cancel buttons do not submit the source form');

    const projectName = '完整项目名称用于验证首字标记的悬停和键盘提示';
    const project = await call('projects.save', {name: projectName, description: '', directory: projectDirectory});
    const chat = await call('conversations.create', {title: '隔离运行态聊天', projectId: null, date: null, model: null});
    await nav('Home').click(); modal = await openTask();
    await modal.getByLabel('内容', {exact: true}).fill('单行项目 Tooltip 测试');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    await page.getByRole('button', {name: '编辑与改期 单行项目 Tooltip 测试', exact: true}).focus(); await page.keyboard.press('Enter'); modal = dialog('编辑待办');
    await selectDropdown(modal.getByRole('combobox', {name: '所属项目', exact: true}), project.id);
    await checkModalLayout(modal, 'modal-task-edit.png');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    const badge = page.locator('.day-panel').getByRole('button', {name: `关联项目 单行项目 Tooltip 测试：${projectName}`, exact: true});
    await badge.hover(); await page.getByRole('tooltip', {name: projectName, exact: true}).waitFor();
    assert.equal(await badge.textContent(), '完');
    await page.mouse.move(2, 100);
    await page.getByRole('tooltip', {name: projectName, exact: true}).waitFor({state: 'hidden'});
    await page.getByRole('textbox', {name: '待办内容 单行项目 Tooltip 测试', exact: true}).focus(); await page.keyboard.press('Tab');
    assert.equal(await badge.evaluate(el => el === document.activeElement), true);
    await page.getByRole('tooltip', {name: projectName, exact: true}).waitFor();
    await page.keyboard.press('Enter');
    const projectMenu = page.getByRole('menu');
    await projectMenu.getByRole('menuitem', {name: projectName, exact: true}).waitFor();
    await projectMenu.getByRole('menuitem', {name: '空', exact: true}).waitFor();
    await until(() => projectMenu.evaluate(el => el.contains(document.activeElement)), 'project menu initial focus');
    await projectMenu.press('Escape'); await projectMenu.waitFor({state: 'hidden'});
    record('Project picker keeps one character with full hover/focus tooltips, opens by keyboard and exposes full project names plus the empty choice');

    for (const [theme, name] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await nav('设置').click(); await page.getByRole('tab', {name: '主题', exact: true}).click();
      await page.getByRole('button', {name, exact: true}).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await nav('Home').click(); await badge.hover();
      const tooltip = page.getByRole('tooltip', {name: projectName, exact: true}); await tooltip.waitFor();
      const tooltipColors = await tooltip.evaluate(el => ({background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, portal: !!el.closest('[data-portal]')}));
      assert.equal(tooltipColors.portal, true); assert.notEqual(tooltipColors.background, tooltipColors.color);
      await page.mouse.move(2, 100); modal = await openTask();
      const colors = await modal.evaluate(el => {
        const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--modal-background)'; el.append(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        return {background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, expected, portal: !!el.closest('[data-portal]'), scheme: document.documentElement.dataset.mantineColorScheme};
      });
      assert.equal(colors.portal, true); assert.equal(colors.background, colors.expected);
      assert.notEqual(colors.background, colors.color); assert.equal(colors.scheme, 'light');
      themeEvidence.push({theme, modal: colors, tooltip: tooltipColors});
      await page.screenshot({path: path.join(output, `modal-${theme}.png`)}); await closeWithEscape(modal);
    }
    assert.deepEqual(themeEvidence[0].modal, themeEvidence[1].modal, 'Default custom theme retains mono modal colors and light color scheme');
    assert.deepEqual(themeEvidence[0].tooltip, themeEvidence[1].tooltip, 'Default custom theme retains mono tooltip colors');
    record('Custom, mono and blue themes propagate to portaled dialogs and tooltips, with distinct foreground/background and matching light color scheme');

    await nav('知识库').click(); await page.getByRole('button', {name: '创建资料', exact: true}).click();
    modal = dialog('创建知识资料');
    await modal.getByLabel('资料名称', {exact: true}).fill('组件知识资料');
    await modal.getByLabel('内容（文本 / Markdown）', {exact: true}).fill('第一版 isolated knowledge');
    await selectDropdown(modal.getByRole('combobox', {name: '所属项目', exact: true}), project.id);
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    const search = page.getByRole('textbox', {name: '搜索知识资料', exact: true});
    await search.fill('nonexistent'); assert.equal(await page.getByRole('heading', {name: '组件知识资料', exact: true}).count(), 0);
    await search.fill('isolated'); await page.getByRole('heading', {name: '组件知识资料', exact: true}).waitFor();
    await selectDropdown(page.getByRole('combobox', {name: '所属项目', exact: true}), '');
    assert.equal(await page.getByRole('heading', {name: '组件知识资料', exact: true}).count(), 0);
    await page.getByRole('checkbox', {name: '全部项目', exact: true}).check();
    await page.getByRole('button', {name: '查看 / 编辑', exact: true}).click(); modal = dialog('编辑知识资料');
    await modal.getByLabel('内容（文本 / Markdown）', {exact: true}).fill('第二版 isolated knowledge');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    const knowledge = (await call('state.get', {})).knowledge.find(k => k.name === '组件知识资料');
    assert.equal(knowledge.content, '第二版 isolated knowledge'); assert.equal(knowledge.version, 2);
    record('Knowledge input/textarea/project picker save and edit, search filters content, and All projects Checkbox restores filtered results');

    const source = await call('sources.save', {name: '仅配置不调用', baseUrl: 'http://127.0.0.1:1/v1', models: [{id: 'fixture-model', name: '隔离模型', supportsTools: false}]});
    await nav('定时任务').click(); await page.getByRole('button', {name: '创建计划', exact: true}).click(); modal = dialog('创建定时任务');
    await modal.getByLabel('计划名称', {exact: true}).fill('组件隔离计划');
    await modal.getByLabel('执行频率', {exact: true}).selectOption('once');
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await modal.getByLabel('日期', {exact: true}).fill(futureDate);
    await modal.getByLabel('当地执行时间', {exact: true}).fill('23:45');
    await modal.getByLabel('IANA 时区', {exact: true}).fill('Asia/Shanghai');
    await selectModel(modal.getByRole('combobox', {name: '选择模型与模型源', exact: true}), JSON.stringify([source.id, 'fixture-model']));
    await modal.getByLabel('提示词', {exact: true}).fill('组件测试，不启用运行');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    let schedule = (await call('state.get', {})).schedules[0];
    assert.deepEqual(schedule.spec, {kind: 'once', date: futureDate, time: '23:45', timezone: 'Asia/Shanghai'});
    assert.equal(schedule.enabled, false); assert.equal(schedule.model.sourceId, source.id);
    await page.getByRole('button', {name: '编辑绑定', exact: true}).click(); modal = dialog('编辑定时任务');
    await modal.getByLabel('执行频率', {exact: true}).selectOption('weekly');
    await modal.getByLabel('星期', {exact: true}).selectOption('5');
    await modal.getByLabel('当地执行时间', {exact: true}).fill('18:30');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    schedule = (await call('state.get', {})).schedules[0];
    assert.deepEqual(schedule.spec, {kind: 'weekly', weekday: 5, time: '18:30', timezone: 'Asia/Shanghai'});
    assert.equal(schedule.enabled, false); assert.equal((await call('state.get', {})).runs.length, 0);
    record('Schedule form preserves native date/time, once/weekly frequency, weekday and fixed model; save/edit stays paused and never runs');

    await nav('插件').click(); await page.getByRole('button', {name: '创建 Skill', exact: true}).click(); modal = dialog('创建 Skill');
    await modal.getByLabel('名称', {exact: true}).fill('组件 Skill');
    await modal.getByLabel('用途说明', {exact: true}).fill('隔离表单测试');
    await modal.getByLabel('指令与输出格式', {exact: true}).fill('只保存说明，不执行任何外部操作。');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    await page.getByRole('button', {name: '查看 / 编辑', exact: true}).click(); modal = dialog('编辑 Skill');
    await modal.getByLabel('用途说明', {exact: true}).fill('已编辑的隔离说明');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    assert.equal((await call('state.get', {})).skills[0].description, '已编辑的隔离说明');
    await page.getByRole('tab', {name: 'MCP', exact: true}).click();
    await page.getByRole('button', {name: '添加 MCP', exact: true}).click(); modal = dialog('添加 MCP 连接');
    await modal.getByLabel('连接名称', {exact: true}).fill('组件 MCP 配置');
    await modal.getByLabel('传输方式', {exact: true}).selectOption('http');
    await modal.getByLabel('HTTP 服务地址', {exact: true}).fill('http://127.0.0.1:1/never-called');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    await page.getByRole('button', {name: '编辑配置', exact: true}).click(); modal = dialog('编辑 MCP 连接');
    await modal.getByLabel('连接名称', {exact: true}).fill('已编辑组件 MCP');
    await modal.getByRole('button', {name: '保存', exact: true}).click(); await modal.waitFor({state: 'hidden'});
    const mcp = (await call('state.get', {})).mcpServers[0];
    assert.equal(mcp.name, '已编辑组件 MCP'); assert.equal(mcp.enabled, false); assert.equal(mcp.credentialConfigured, false);
    record('Skill and MCP input/textarea/transport forms save and edit; MCP remains disabled without credentials or discovery');

    await app.evaluate((_, id) => { globalThis.__componentFixture.activeChat = id; globalThis.__componentFixture.virtualMcp = true; }, chat.id);
    await page.reload(); await nav('项目').click();
    const chatMenu = page.getByRole('button', {name: '聊天操作 隔离运行态聊天', exact: true});
    await chatMenu.click();
    const move = page.getByRole('menuitem', {name: '移动', exact: true});
    await move.waitFor();
    assert.equal(await move.isDisabled(), true);
    await page.getByRole('menu').getByText('完成或停止生成后才能移动或归档', {exact: true}).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state: 'hidden'});
    await chatMenu.focus(); assert.equal(await chatMenu.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter'); await move.waitFor();
    assert.equal(await move.isDisabled(), true);
    await page.getByRole('menu').getByText('完成或停止生成后才能移动或归档', {exact: true}).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state: 'hidden'});
    record('Running chat menu opens by mouse and keyboard; disabled move action has a complete visible explanation');

    await nav('插件').click(); const skillTab = page.getByRole('tab', {name: 'Skill', exact: true});
    await skillTab.focus(); await page.keyboard.press('ArrowRight');
    await until(() => page.getByRole('tab', {name: 'MCP', exact: true}).evaluate(el => el.getAttribute('aria-selected') === 'true'), 'keyboard switches plugins tab');
    assert.equal(await page.getByRole('tabpanel', {name: 'MCP', exact: true}).isVisible(), true);
    await page.getByRole('button', {name: '授权只读范围', exact: true}).click(); modal = dialog('授予具体只读能力');
    const confirm = modal.getByRole('checkbox', {name: '我信任此服务，确认此能力只读，并授权上述具体范围', exact: true});
    await modal.getByRole('button', {name: '授予只读权限', exact: true}).click();
    assert.equal(await confirm.evaluate(el => el.validity.valueMissing), true); assert.equal(await count('grants.save'), 0);
    await confirm.check(); await modal.getByRole('button', {name: '授予只读权限', exact: true}).click();
    await modal.getByRole('alert').waitFor(); assert.equal(await count('grants.save'), 1);
    assert.match(await modal.getByRole('alert').textContent(), /只读授权测试已截获/);
    record('Plugin Tabs keyboard/panel behavior works; required consent Checkbox blocks unchecked submission and allows the intercepted checked submission');

    for (const [width, height] of [[1500, 980], [1100, 620], [660, 620]]) {
      await app.evaluate(({BrowserWindow}, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height]);
      await page.waitForFunction(width => innerWidth === width, width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await checkModalLayout(modal, `grant-${width}.png`, width === 660);
    }
    record('Task edit and manual-model forms fit their dialogs; long source/grant dialogs scroll internally with title/footer fixed and no horizontal overflow in 660px windows');
    await closeWithEscape(modal);
    const fixture = await app.evaluate(() => ({calls: globalThis.__componentFixture.calls, blocked: globalThis.__componentFixture.blocked, weatherBeforeEntry: globalThis.__weatherFixture.installedBeforeEntry}));
    assert.deepEqual(fixture.blocked, []); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({passed: true, realElectron: true, executable: await app.evaluate(() => process.execPath), dataDirectory: data, checks, themeEvidence, fixture, consoleErrors: errors, personalData: false, personalCredentials: false, publicModelRequests: false, mcpNetwork: false, limitation: 'MCP server/active-chat state and grant result are isolated IPC fixtures; no server connection or actual authorization is exercised.'}, null, 2));
    console.log(JSON.stringify({passed: true, checks: checks.length, output}));
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
      await fs.writeFile(path.join(output, 'failure-aria.yml'), await page.locator('body').ariaSnapshot()).catch(() => {});
      await fs.writeFile(path.join(output, 'failure-state.json'), JSON.stringify({checks, errors, focus: await page.evaluate(() => ({tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label'), html: document.activeElement?.outerHTML.slice(0, 600)}))}, null, 2)).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
