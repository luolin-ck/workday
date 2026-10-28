const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-task-corner-'));
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source', output = path.join(root, 'output/playwright', `task-corner-${kind}`);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const meetings = [{ id: 'fixture-meeting', title: '合成项目讨论会议', start: `${today}T09:00:00+08:00`, end: `${today}T10:00:00+08:00`, allDay: false, startDate: null, endDate: null }];
  const checks = [], layouts = [], errors = []; let app, page, task;
  const row = () => page.locator(`.task-row[data-task-id="${task.id}"]`);
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) {
    for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  async function call(operation, input) {
    const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  const saved = async () => (await call('state.get', {})).tasks.find(item => item.id === task.id);
  async function leave() { await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur?.()); }
  async function controls(shown) {
    const actions = row().locator('.task-edit-action,.task-delete-action');
    assert.equal(await actions.count(), 2, 'Edit button and delete wrapper have dedicated reveal classes');
    await until(() => actions.evaluateAll((elements, shown) => elements.every(element => {
      const style = getComputedStyle(element); return style.opacity === (shown ? '1' : '0') && style.pointerEvents === (shown ? 'auto' : 'none');
    }), shown), shown ? 'actions revealed' : 'actions hidden');
    assert.equal(await row().locator('.task-priority-picker').isVisible(), true);
    assert.equal(await row().locator('.task-project-picker').isVisible(), true);
  }
  async function geometry() {
    return row().evaluate(element => [element, element.querySelector('.task-title input'), ...element.querySelectorAll('.task-edit-action,.task-delete-action')].map(item => {
      const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
  }
  function sameGeometry(before, after) {
    for (let i = 0; i < before.length; i++) for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[i][key] - after[i][key]) <= 1, `Revealing actions must not move or resize content (${i}.${key})`);
  }
  async function cornerGeometry(target = row()) {
    const layout = await target.evaluate(element => {
      const bounds = item => { const r = item.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const input = element.querySelector('.task-title input'), actions = [...element.querySelectorAll('.task-edit-action,.task-delete-action')];
      const before = bounds(input), originalStyles = actions.map(action => action.getAttribute('style'));
      actions.forEach(action => action.style.display = 'none');
      const withoutActions = bounds(input);
      actions.forEach((action, index) => originalStyles[index] == null ? action.removeAttribute('style') : action.setAttribute('style', originalStyles[index]));
      const buttons = [element.querySelector('.task-edit-action'), element.querySelector('.task-delete-action button')];
      return { row: bounds(element), title: before, withoutActions, metadata: bounds(element.querySelector('.task-actions')), controls: [...element.querySelectorAll('.task-deadline,.task-priority-picker,.task-project-picker')].map(bounds), actions: buttons.map(bounds), paddingRight: parseFloat(getComputedStyle(element).paddingRight) };
    });
    assert.ok(Math.abs(layout.title.width - layout.withoutActions.width) <= 1, `Removing edit/delete must not widen the title: corner actions must release their former inline slots. ${JSON.stringify(layout)}`);
    assert.ok(layout.row.right - layout.paddingRight - layout.metadata.right <= 1, `Metadata should use the right edge without empty action slots: ${JSON.stringify(layout)}`);
    const [edit, remove] = layout.actions;
    assert.ok(edit.right <= remove.left && Math.abs(edit.top - remove.top) <= 1, `Corner buttons share a compact non-overlapping row: ${JSON.stringify(layout)}`);
    for (const action of layout.actions) {
      assert.ok(action.width >= 16 && action.height >= 16 && action.width <= 26 && action.height <= 26, `Corner buttons retain a compact usable target: ${JSON.stringify(layout)}`);
      assert.ok(Math.abs(action.top + action.height / 2 - layout.row.top) <= 2 && action.right <= layout.row.right, `Action buttons straddle the card's upper right edge: ${JSON.stringify(layout)}`);
      assert.ok([layout.title, ...layout.controls].every(control => action.right <= control.left || action.left >= control.right || action.bottom <= control.top || action.top >= control.bottom), `Corner actions do not cover the title or metadata: ${JSON.stringify(layout)}`);
    }
    assert.ok(layout.row.right - remove.right <= layout.paddingRight + 1, `Delete action anchors at the right edge: ${JSON.stringify(layout)}`);
    return layout;
  }
  async function assertHitTargets(target = row()) {
    for (const selector of ['.task-edit-action', '.task-delete-action button']) {
      const button = target.locator(selector);
      await button.hover();
      assert.equal(await button.evaluate(element => {
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === element || element.contains(hit);
      }), true, 'Visible corner buttons must be hit-testable above neighboring cards');
      await button.click({ trial: true });
    }
  }
  async function meetingTimeTag() {
    const meeting = page.locator('.day-panel .meeting-row').first();
    const layout = await meeting.evaluate(element => {
      const time = element.querySelector('.meeting-time'), title = element.querySelector('.meeting-title'), style = getComputedStyle(time), timeRect = time.getBoundingClientRect(), titleRect = title.getBoundingClientRect();
      return { text: time.textContent, label: element.getAttribute('aria-label'), background: style.backgroundColor, radius: parseFloat(style.borderRadius), fontSize: parseFloat(style.fontSize), titleFontSize: parseFloat(getComputedStyle(title).fontSize), whiteSpace: style.whiteSpace, fits: time.scrollWidth <= time.clientWidth + 1, gap: titleRect.left - timeRect.right, centerDifference: Math.abs(timeRect.top + timeRect.height / 2 - titleRect.top - titleRect.height / 2) };
    });
    assert.equal(layout.text, '09:00–10:00', 'Meeting time text must preserve the complete time range');
    assert.equal(layout.label, '09:00–10:00 合成项目讨论会议', 'The accessible meeting label retains its complete time and title');
    assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', 'Meeting time needs a visible subtle tag background');
    assert.ok(layout.radius > 0 && layout.fontSize > 0 && layout.fontSize < layout.titleFontSize, `Meeting time should be a small rounded tag: ${JSON.stringify(layout)}`);
    assert.ok(layout.whiteSpace === 'nowrap' && layout.fits && layout.gap >= 4 && layout.centerDifference <= 1, `Time range stays fully readable on one line without overlapping its title: ${JSON.stringify(layout)}`);
    await meeting.hover(); await page.getByRole('tooltip', { name: layout.label, exact: true }).waitFor();
    await leave(); await page.getByRole('tooltip', { name: layout.label, exact: true }).waitFor({ state: 'hidden' });
    return layout;
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000 }, { mockHolidays: true, meetings: { status: 'ready', meetings } });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1500, 980); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call'); globalThis.__dayCardsBlocked = [];
      ipcMain.removeHandler('workday:call'); ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) {
          globalThis.__dayCardsBlocked.push(operation); throw new Error('External operations disabled in day-cards fixture');
        }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    task = await call('tasks.save', { title: '合成卡片事项', notes: '', date: today, dueDate: today, priority: 'P2', completed: false, projectId: null });
    await call('tasks.save', { title: '另一个较长的合成事项用于检查紧凑宽度和单行省略显示', notes: '', date: today, dueDate: null, priority: 'P1', completed: false, projectId: null });
    await row().waitFor(); await page.locator('.meeting-row').waitFor(); await leave();
    const initial = await row().evaluate(element => { const style = getComputedStyle(element); return { border: style.borderTopWidth, background: style.backgroundColor }; });
    assert.equal(initial.border, '0px', 'Task cards must not use a top divider');
    assert.notEqual(initial.background, 'rgba(0, 0, 0, 0)', 'Task cards need their own visible background');
    record('Task rows are cards with a visible background and no divider line');
    await meetingTimeTag();
    record('Meeting times use a small rounded tag with the complete time range, matching tooltip and clear separation from the title');

    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await row().waitFor(); await page.locator('.meeting-row').waitFor();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const width of [1500, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width); await row().scrollIntoViewIfNeeded(); await leave();
        const styles = await page.locator('.day-panel .meeting-row,.day-panel .task-row').evaluateAll(elements => elements.map(element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect(), parent = element.closest('.task-list').getBoundingClientRect();
          return { color: style.backgroundColor, radius: style.borderRadius, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], width: rect.width, inside: rect.left >= parent.left - 1 && rect.right <= parent.right + 1, titleWrap: element.querySelector('.meeting-title') ? getComputedStyle(element.querySelector('.meeting-title')).whiteSpace : getComputedStyle(element.querySelector('.task-title input')).whiteSpace };
        }));
        assert.equal(styles.length, 3);
        for (const style of styles) {
          assert.ok(style.borders.every(value => value === '0px'), 'No meeting or task separator borders');
          assert.equal(style.color, styles[0].color, 'Meetings and tasks share the same card surface');
          assert.notEqual(style.color, 'rgba(0, 0, 0, 0)');
          assert.equal(style.radius, styles[0].radius); assert.ok(parseFloat(style.radius) > 0);
          assert.deepEqual(style.padding, styles[0].padding); assert.ok(parseFloat(style.padding[1]) > 0);
          assert.ok(style.inside && Math.abs(style.width - styles[0].width) <= 1); assert.equal(style.titleWrap, 'nowrap');
        }
        const timeTag = await meetingTimeTag();
        await controls(false); const before = await geometry(), corners = await cornerGeometry();
        await row().hover(); await controls(true); sameGeometry(before, await geometry()); await assertHitTargets();
        await leave(); await controls(false);
        await row().locator('.task-edit-action').focus(); await controls(true); sameGeometry(before, await geometry());
        await leave(); await controls(false);
        layouts.push({ theme, width, styles, corners, timeTag });
        if (width === 1500) {
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
          await page.locator('.day-panel').screenshot({ path: path.join(output, `${theme}-day-panel.png`), animations: 'disabled' });
          await row().hover(); await controls(true);
          await page.locator('.day-panel').screenshot({ path: path.join(output, `${theme}-hover.png`), animations: 'disabled' });
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        }
      }
    }
    record('Three themes at desktop and narrow widths free the old inline action slots; compact upper-right controls remain hit-testable without covering metadata or shifting text');

    await row().locator('.task-priority-picker').click();
    await page.getByRole('menuitem', { name: 'P1', exact: true }).click(); await until(async () => (await saved()).priority === 'P1', 'priority menu saves');
    await row().locator('.task-project-picker').click(); await page.getByRole('menuitem', { name: '空', exact: true }).click();
    await row().getByRole('textbox').fill('合成卡片实时编辑'); await row().getByRole('textbox').press('Enter');
    await until(async () => (await saved()).title === '合成卡片实时编辑', 'inline title saves');
    await row().hover(); await row().locator('.task-edit-action').click();
    await page.getByRole('dialog', { name: '编辑待办', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '编辑待办', exact: true }).waitFor({ state: 'detached' });
    await leave(); await row().locator('.task-edit-action').focus(); await controls(true);
    await page.keyboard.press('Tab'); await page.waitForFunction(id => document.activeElement === document.querySelector(`.task-row[data-task-id="${id}"] .task-delete-action button`), task.id);
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '编辑待办', exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByLabel('内容', { exact: true }).inputValue(), '合成卡片实时编辑');
    await dialog.getByLabel('备注', { exact: true }).fill('合成卡片弹窗验证'); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await saved()).notes === '合成卡片弹窗验证', 'editor saves');
    await leave(); await controls(false);
    record('Priority/project menus and inline editing remain usable; pointer and keyboard open the editor, and Tab traverses both corner buttons');

    const scrollTasks = [];
    for (let index = 0; index < 18; index++) scrollTasks.push(await call('tasks.save', { title: `合成滚动事项 ${index + 1}`, notes: '', date: today, dueDate: null, priority: 'P2', completed: false, projectId: null }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 740));
    await page.waitForFunction(() => innerWidth === 1500);
    for (const item of [task, scrollTasks[9]]) {
      const target = page.locator(`.task-row[data-task-id="${item.id}"]`);
      await target.scrollIntoViewIfNeeded(); await target.hover(); await cornerGeometry(target); await assertHitTargets(target);
    }
    record('First and middle cards remain clickable after scrolling into view in an overflowing task list');
    for (const item of scrollTasks) await call('tasks.delete', { id: item.id, expectedVersion: item.version });
    await row().scrollIntoViewIfNeeded();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true, 'Fixture should emulate a device without hover');
    await leave(); await controls(true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
    await leave(); await controls(false);
    await row().locator('.task-edit-action').focus(); await controls(true); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await row().waitFor({ state: 'hidden' }); assert.ok((await saved()).deletedAt);
    assert.equal(await page.locator('.day-panel .meeting-row').count(), 1);
    record('On a device without hover, actions remain available; keyboard deletion works without affecting meetings');
    assert.deepEqual(await app.evaluate(() => globalThis.__dayCardsBlocked), []); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, layouts, executable: await app.evaluate(() => process.execPath), dataDirectory: data, personalData: false, modelRequests: 0, nativeNotifications: false, meetings: 'synthetic fixture installed before entry' }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }, null, 2));
  } catch (error) {
    if (page && !page.isClosed()) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
