const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-workspace-spacing-'));
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source', output = path.join(root, 'output/playwright', `workspace-spacing-${kind}`);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const layouts = [], errors = [], checks = [];
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  const size = async width => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
    await page.waitForFunction(width => innerWidth === width, width);
  };
  const measure = () => page.locator('.workspace').evaluate(element => {
    const style = getComputedStyle(element), bounds = selector => { const item = document.querySelector(selector); if (!item) return null; const r = item.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat), gap: [style.rowGap, style.columnGap].map(parseFloat), columnGap: parseFloat(getComputedStyle(document.querySelector('.conversation-column')).rowGap), workspace: bounds('.workspace'), calendar: bounds('.calendar'), column: bounds('.conversation-column'), daily: bounds('.daily-wrapper'), chat: bounds('.chat'), composer: bounds('.composer-input'), overflow: element.scrollWidth > element.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop, viewportHeight: innerHeight };
  });
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call'); globalThis.__spacingBlocked = [];
      ipcMain.removeHandler('workday:call'); ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) { globalThis.__spacingBlocked.push(operation); throw new Error('External operations disabled in spacing fixture'); }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await setFixtureTheme(page, 'mono'); await page.locator('.day-panel').waitFor();
    const saved = await page.evaluate(async () => {
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
      return Promise.all(['合成布局事项', '另一条合成事项'].map(title => window.workday.call('tasks.save', { title, notes: '', date, dueDate: null, priority: 'P2', completed: false, projectId: null })));
    });
    assert.ok(saved.every(result => result.ok)); await page.locator('.task-row[data-task-id]').first().waitFor();
    for (const width of [1500, 1100, 660]) {
      await size(width); await page.locator('.workspace').evaluate(element => { element.scrollTop = 0; });
      const measured = await measure(); layouts.push({ width, measured }); console.log(JSON.stringify({ width, measured }));
      const oldPadding = width <= 740 ? 10 : width <= 1160 ? 14 : 19, oldGap = width <= 1160 ? 12 : 15;
      assert.ok(measured.padding.every(value => value <= oldPadding / 2), `Workspace padding must be at most half of ${oldPadding}px: ${measured.padding}`);
      assert.deepEqual(measured.padding, [5, 5, 5, 5]); assert.deepEqual(measured.gap, [5, 5]);
      assert.ok(measured.gap.every(value => value <= oldGap / 2)); assert.equal(measured.columnGap, 4); assert.equal(measured.overflow, false);
      near(measured.calendar.left - measured.workspace.left, 5, 'Calendar left gutter');
      near(measured.calendar.top - measured.workspace.top, 5, 'Calendar top gutter');
      near(measured.workspace.right - measured.column.right, 5, 'Right column outer gutter');
      near(measured.chat.top - measured.daily.bottom, 4, 'Day panel to chat gap');
      if (width > 970) {
        near(measured.column.left - measured.calendar.right, 5, 'Desktop column gap');
        near(measured.column.top - measured.workspace.top, 5, 'Right column top gutter');
        near(measured.workspace.bottom - measured.calendar.bottom, 5, 'Calendar bottom gutter');
        near(measured.workspace.bottom - measured.column.bottom, 5, 'Right column bottom gutter');
        assert.ok(measured.composer.bottom <= measured.workspace.bottom - 4 && measured.workspace.bottom <= measured.viewportHeight + 1);
        assert.ok(measured.scrollHeight <= measured.clientHeight + 1, 'Desktop workspace must not scroll vertically');
      } else {
        near(measured.column.top - measured.calendar.bottom, 5, 'Stacked panel gap');
        assert.ok(measured.scrollHeight > measured.clientHeight, 'Narrow layout should scroll vertically');
        await page.locator('.workspace').evaluate(element => { element.scrollTop = element.scrollHeight; });
        const end = await measure(); layouts.push({ width, scrolled: end });
        assert.ok(end.scrollTop > 0 && end.composer.top >= end.workspace.top && end.composer.bottom <= end.workspace.bottom - 4, 'Composer must be fully reachable at the bottom');
        assert.equal(end.overflow, false); near(end.workspace.bottom - end.column.bottom, 5, 'Narrow bottom gutter');
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      const contentSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], contentSize);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(output, `mono-${width}.png`), animations: 'disabled' });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      record(`${width}px: uniform 5px workspace gutters/gap, 4px inner gap, contained panels and reachable composer`);
    }
    await size(1100); await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await page.locator('.workspace.projects').waitFor(); const projects = await measure();
    assert.deepEqual(projects.padding, [0, 0, 0, 0]); assert.deepEqual(projects.gap, [0, 0]); assert.equal(projects.overflow, false);
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-page').waitFor(); const settings = await measure();
    assert.deepEqual(settings.padding, [5, 5, 5, 5]); assert.equal(settings.overflow, false);
    record('Project workspace remains edge-to-edge; Settings uses the shared compact outer gutter');
    assert.deepEqual(await app.evaluate(() => globalThis.__spacingBlocked), []); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, layouts, projects, settings, dataDirectory: data, personalData: false, modelRequests: 0, executable: await app.evaluate(() => process.execPath) }, null, 2));
    console.log(JSON.stringify({ passed: true, output }));
  } catch (error) {
    if (page && !page.isClosed()) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {}); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
