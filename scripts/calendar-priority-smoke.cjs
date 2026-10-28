const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-calendar-priority-'));
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `calendar-priority-${kind}`);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const month = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1, 12);
  const date = day => `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dates = [13, 14, 15, 16, 17].map(date), checks = [], measurements = [], errors = [];
  let app, page;
  const cell = day => page.locator(`.day[aria-label^="${day}"]`);
  const pending = day => cell(day).locator('.pending-count');
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function call(operation, input) {
    const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  async function openMonth() {
    const current = (await page.locator('.calendar h1').textContent()).match(/(\d+)年\s*(\d+)月/);
    assert.ok(current);
    const offset = (month.getFullYear() - Number(current[1])) * 12 + month.getMonth() + 1 - Number(current[2]);
    for (let i = 0; i < Math.abs(offset); i++) await page.getByRole('button', { name: offset > 0 ? '下个月' : '上个月', exact: true }).click();
    await pending(dates[0]).waitFor(); await settle();
  }
  async function save(name, day, priority, extra = {}) {
    return call('tasks.save', { title: `合成月历优先级 ${name}`, notes: '', date: day, dueDate: null, completed: false, projectId: null, ...(priority ? { priority } : {}), ...extra });
  }
  async function update(task, changes) {
    return call('tasks.save', { id: task.id, expectedVersion: task.version, title: task.title, notes: task.notes, date: task.date, dueDate: task.dueDate, priority: task.priority, completed: task.completed, completedDate: task.completedDate, projectId: task.projectId, ...changes });
  }
  async function inspect(day, priority, count, theme, state = 'normal') {
    await page.waitForFunction(({ day, priority, count }) => {
      const element = document.querySelector(`.day[aria-label^="${day}"] .pending-count`);
      return element?.dataset.pendingPriority === priority && element.textContent === String(count);
    }, { day, priority, count });
    const value = await pending(day).evaluate((element, priority) => {
      const style = getComputedStyle(element), svg = element.querySelector('svg'), iconStyle = getComputedStyle(svg);
      const rect = element.getBoundingClientRect(), iconRect = svg.getBoundingClientRect(), owner = element.closest('.day'), ownerRect = owner.getBoundingClientRect();
      const probe = document.createElement('span'); probe.style.color = `var(--priority-${priority.toLowerCase()}-text)`; element.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return { color: style.color, iconColor: iconStyle.color, stroke: iconStyle.stroke, expected, background: style.backgroundColor, image: style.backgroundImage,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        width: rect.width, height: rect.height, iconWidth: iconRect.width, iconHeight: iconRect.height, leftInset: rect.left - ownerRect.left, bottomInset: ownerRect.bottom - rect.bottom,
        contained: rect.left >= ownerRect.left && rect.right <= ownerRect.right && rect.top >= ownerRect.top && rect.bottom <= ownerRect.bottom,
        cellImage: getComputedStyle(owner).backgroundImage, selected: owner.getAttribute('aria-pressed'), text: element.textContent };
    }, priority);
    const label = `${theme}/${day}/${state}`;
    assert.equal(value.color, value.expected, label + ': use the existing semantic priority text color');
    assert.equal(value.iconColor, value.color, label + ': circle and number share one color');
    assert.equal(value.stroke, value.color, label + ': the circle stroke uses the priority color');
    assert.equal(value.background, 'rgba(0, 0, 0, 0)', label + ': counts have no badge fill');
    assert.equal(value.image, 'none');
    assert.ok([...value.padding, ...value.border].every(size => size === '0px'), label + ': no badge padding or border changes geometry');
    assert.ok(value.contained && value.width > 0 && value.height > 0 && value.iconWidth > 0 && value.iconHeight > 0, label + ': count remains contained and visible');
    assert.equal(value.text, String(count));
    if (day === dates[0]) assert.match(value.cellImage, /repeating-linear-gradient/, label + ': deadline stripes remain underneath the colored count');
    measurements.push({ day, priority, count, theme, state, ...value }); return value;
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setSize(1500, 980); window.webContents.setBackgroundThrottling(false); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call'); globalThis.__calendarPriorityBlocked = [];
      ipcMain.removeHandler('workday:call'); ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) {
          globalThis.__calendarPriorityBlocked.push(operation); throw new Error('External operations disabled in calendar-priority fixture');
        }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    let top = await save('P0 混合', dates[0], 'P0', { dueDate: dates[0] });
    let middle = await save('P1 混合', dates[0], 'P1');
    const low = await save('P2 混合', dates[0], 'P2');
    await save('另一日期 P1', dates[1], 'P1'); await save('另一日期 P2', dates[1], 'P2');
    await save('默认 P2', dates[2]);
    await save('已完成 P0 不染色', dates[1], 'P0', { completed: true, completedDate: dates[1] });
    const removed = await save('已删除 P0 不染色', dates[1], 'P0'); await call('tasks.delete', { id: removed.id, expectedVersion: removed.version });
    await save('只有完成记录', dates[3], 'P0', { completed: true, completedDate: dates[3] });
    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await openMonth();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      const layouts = [];
      for (const [index, priority, count] of [[0, 'P0', 3], [1, 'P1', 2], [2, 'P2', 1]]) {
        await cell(dates[4]).click(); await page.mouse.move(0, 0); await settle();
        layouts.push(await inspect(dates[index], priority, count, theme));
        await cell(dates[index]).hover(); await inspect(dates[index], priority, count, theme, 'hover');
        await cell(dates[index]).click(); await page.mouse.move(0, 0); await settle();
        assert.equal(await cell(dates[index]).getAttribute('aria-pressed'), 'true');
        await inspect(dates[index], priority, count, theme, 'selected');
      }
      for (const key of ['width', 'height', 'iconWidth', 'iconHeight', 'leftInset', 'bottomInset']) {
        assert.ok(Math.max(...layouts.map(item => item[key])) - Math.min(...layouts.map(item => item[key])) <= 1, `${theme}: all priority colors preserve the same count geometry (${key})`);
      }
      assert.equal(await pending(dates[3]).count(), 0); assert.equal(await pending(dates[4]).count(), 0);
      await cell(dates[0]).click(); await page.mouse.move(0, 0);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await page.locator('.calendar').screenshot({ path: path.join(output, `${theme}-calendar.png`), animations: 'disabled' });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    }
    record('Three themes show the day’s highest pending priority in one shared circle/number color, without badges or layout changes, including hover, selection and deadline stripes');
    record('Completed/deleted P0 tasks and higher-priority tasks on other dates do not affect the day; omitted priority defaults to P2');
    const before = await inspect(dates[0], 'P0', 3, 'blue', 'before-update');
    top = await update(top, { priority: 'P2' });
    const after = await inspect(dates[0], 'P1', 3, 'blue', 'priority-lowered');
    for (const key of ['width', 'height', 'iconWidth', 'iconHeight', 'leftInset', 'bottomInset']) assert.ok(Math.abs(before[key] - after[key]) <= 1, 'Priority-only updates must not move or resize counts');
    await inspect(dates[1], 'P1', 2, 'blue', 'other-day-unchanged');
    middle = await update(middle, { completed: true, completedDate: dates[0] });
    await inspect(dates[0], 'P2', 2, 'blue', 'highest-completed');
    await call('tasks.delete', { id: low.id, expectedVersion: low.version });
    await inspect(dates[0], 'P2', 1, 'blue', 'one-pending-left');
    await call('tasks.delete', { id: top.id, expectedVersion: top.version });
    await pending(dates[0]).waitFor({ state: 'hidden' });
    assert.equal(await cell(dates[0]).locator('.done-count').textContent(), '1');
    await inspect(dates[1], 'P1', 2, 'blue', 'other-day-still-unchanged');
    await inspect(dates[2], 'P2', 1, 'blue', 'default-priority-unchanged');
    record('Changing priority or completing the highest item immediately lowers the day’s color; deleting the last pending item hides its count while preserving completed records and other dates');
    assert.deepEqual(await app.evaluate(() => globalThis.__calendarPriorityBlocked), []); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, measurements, dates, dataDirectory: data, executable: await app.evaluate(() => process.execPath), personalData: false, modelRequests: 0, nativeNotifications: false }, null, 2));
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
