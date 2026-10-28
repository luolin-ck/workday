const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-deadline-pattern-'));
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `deadline-pattern-${kind}`);
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const { parseHolidayNotice } = require('../dist/main/holidays.js');
  const days = parseHolidayNotice(await fs.readFile(path.join(root, 'tests/fixtures/holidays-2026.html'), 'utf8'), 2026);
  await fs.mkdir(path.join(data, 'holidays'), { recursive: true });
  await fs.writeFile(path.join(data, 'holidays/2026.json'), JSON.stringify({ parserVersion: 1, year: 2026, sourceUrl: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm', sourceTitle: '国务院办公厅关于2026年部分节假日安排的通知', queriedAt: new Date().toISOString(), days }));
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], measurements = [], errors = [];
  let app, page;
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  const cell = date => page.locator(`.day[aria-label^="${date}"]`);
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function call(operation, input) {
    const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  async function october() {
    const current = (await page.locator('.calendar h1').textContent()).match(/(\d+)年\s*(\d+)月/);
    assert.ok(current, 'Calendar month heading should be available');
    const offset = (2026 - Number(current[1])) * 12 + 10 - Number(current[2]);
    for (let i = 0; i < Math.abs(offset); i++) await page.getByRole('button', { name: offset > 0 ? '下个月' : '上个月', exact: true }).click();
    await cell('2026-10-01').locator('.holiday-mark.rest').waitFor();
    await cell('2026-10-10').locator('.holiday-mark.work').waitFor();
    await settle();
  }
  async function inspect(date, theme, state, patterned = true) {
    const value = await cell(date).evaluate(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const holiday = element.dataset.holiday, selected = element.getAttribute('aria-pressed') === 'true', hovered = element.matches(':hover');
      const token = holiday === 'rest' ? '--rest-background' : holiday === 'work' ? '--work-background' : hovered ? '--day-hover' : selected ? '--day-selected' : element.classList.contains('weekend') ? '--weekend-background' : '--day-background';
      const probe = document.createElement('span'); probe.style.backgroundColor = `var(${token})`; element.append(probe);
      const expectedColor = getComputedStyle(probe).backgroundColor; probe.remove();
      const children = [...element.querySelectorAll('.day-number,.lunar-date,.deadline-mark,.holiday-kind')].map(child => {
        const bounds = child.getBoundingClientRect(), computed = getComputedStyle(child);
        return { width: bounds.width, height: bounds.height, contained: bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1 && bounds.top >= rect.top - 1 && bounds.bottom <= rect.bottom + 1, opacity: computed.opacity };
      });
      return { image: style.backgroundImage, color: style.backgroundColor, expectedColor, expectedToken: token, size: style.backgroundSize, repeat: style.backgroundRepeat, opacity: style.opacity, selected, hovered, text: element.innerText, markers: element.querySelectorAll('.deadline-mark').length, children };
    });
    const label = `${theme}/${date}/${state}`;
    if (patterned) {
      assert.match(value.image, /repeating-linear-gradient\(/, label + ': deadline cells need diagonal stripes');
      const alphas = [...value.image.matchAll(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/g)].map(match => Number(match[1]));
      assert.ok(alphas.some(alpha => alpha > 0 && alpha < 1), label + ': stripe color must be translucent white');
      assert.match(value.size, /^auto(?:,\s*auto)*$/, label + ': gradient fills the whole cell rather than a sized badge');
      assert.ok(value.repeat.split(',').every(item => item.trim() === 'repeat'), label + ': full background should retain its normal repeat behavior');
      assert.equal(value.markers, 1, label + ': the existing deadline icon remains available');
    } else {
      assert.doesNotMatch(value.image, /repeating-linear-gradient\(/, label + ': non-deadline cells must not gain stripes');
      assert.equal(value.markers, 0);
    }
    assert.equal(value.color, value.expectedColor, label + ': preserve the original ordinary/weekend/holiday/state background color');
    assert.equal(value.opacity, '1', label + ': translucency belongs to the stripes, not the whole cell');
    assert.ok(value.children.every(child => child.width > 0 && child.height > 0 && child.contained && child.opacity === '1'), label + ': dates, lunar labels and markers remain visible and contained');
    assert.doesNotMatch(value.text, /合成截止事项/, label + ': no task titles are added to calendar cells');
    measurements.push({ date, theme, state, patterned, ...value });
  }
  async function saveDue(name, dueDate, completed = false) {
    return call('tasks.save', { title: `合成截止事项 ${name}`, notes: '', date: '2027-05-20', dueDate, completed, projectId: null });
  }
  async function update(task, change) {
    const saved = await call('tasks.save', { id: task.id, expectedVersion: task.version, title: task.title, notes: task.notes, date: task.date, dueDate: task.dueDate, completed: task.completed, projectId: task.projectId, ...change });
    await settle(); return saved;
  }
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1500, 980); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call'); globalThis.__deadlineBlockedOperations = [];
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) {
          globalThis.__deadlineBlockedOperations.push(operation);
          throw new Error('External operations disabled in deadline pattern fixture');
        }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const normal = await saveDue('普通日期', '2026-10-13');
    const weekend = await saveDue('周末', '2026-10-11');
    await saveDue('国庆休息', '2026-10-01');
    await saveDue('调休上班', '2026-10-10');
    await saveDue('已完成', '2026-10-15', true);
    const deleted = await saveDue('已删除', '2026-10-16');
    await call('tasks.delete', { id: deleted.id, expectedVersion: deleted.version });
    await saveDue('无截止日期', null);
    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await october();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      for (const date of ['2026-10-13', '2026-10-11', '2026-10-01', '2026-10-10']) {
        await cell('2026-10-19').click(); await page.mouse.move(0, 0); await settle();
        await inspect(date, theme, 'normal');
        await cell(date).hover(); await settle(); await inspect(date, theme, 'hover');
        await cell(date).click(); await page.mouse.move(0, 0); await settle();
        assert.equal(await cell(date).getAttribute('aria-pressed'), 'true', 'The striped date remains clickable');
        const selectionShadow = await cell(date).evaluate(element => getComputedStyle(element).boxShadow);
        assert.notEqual(selectionShadow, 'none', 'Selection outline remains visible');
        await inspect(date, theme, 'selected');
      }
      for (const date of ['2026-10-15', '2026-10-16', '2026-10-17']) await inspect(date, theme, 'excluded', false);
      await cell('2026-10-13').click(); await page.mouse.move(0, 0); await settle();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await page.locator('.calendar').screenshot({ path: path.join(output, `${theme}-calendar.png`), animations: 'disabled' });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    }
    record('Translucent white full-cell diagonal stripes survive three themes, ordinary/weekend/rest/work dates, hover and selection while retaining background colors and readable content');
    record('No deadline, completed and deleted tasks produce neither deadline stripes nor deadline icons');

    let changed = await update(normal, { dueDate: '2026-10-14' });
    await cell('2026-10-13').locator('.deadline-mark').waitFor({ state: 'hidden' });
    await cell('2026-10-14').locator('.deadline-mark').waitFor();
    await inspect('2026-10-13', 'blue', 'moved-away', false);
    await inspect('2026-10-14', 'blue', 'new-deadline');
    changed = await update(changed, { completed: true });
    await cell('2026-10-14').locator('.deadline-mark').waitFor({ state: 'hidden' });
    await inspect('2026-10-14', 'blue', 'completed-after-render', false);
    await call('tasks.delete', { id: weekend.id, expectedVersion: weekend.version });
    await cell('2026-10-11').locator('.deadline-mark').waitFor({ state: 'hidden' });
    await inspect('2026-10-11', 'blue', 'deleted-after-render', false);
    record('Changing a deadline moves the stripes immediately; completing or deleting the remaining task removes them');
    assert.deepEqual(await app.evaluate(() => globalThis.__deadlineBlockedOperations), []);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, measurements, executable: await app.evaluate(() => process.execPath), dataDirectory: data, personalData: false, modelRequests: 0, weatherAndHolidays: 'isolated fixtures' }, null, 2));
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
