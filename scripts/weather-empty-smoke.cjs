const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-weather-empty-')), output = path.join(root, 'output/playwright', `weather-empty-${kind}`);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const add = offset => new Date(Date.parse(today + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  let app, page; const checks = [], errors = [];
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) {
    for (let index = 0; index < 160; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  async function ready(date, temperature) {
    await page.locator(`.weather-block[data-weather-date="${date}"][data-weather-state="ready"]`).waitFor();
    assert.equal(await page.locator('.weather-city').textContent(), '出口城市');
    assert.equal(await page.locator('.weather-temperature').textContent(), temperature);
  }
  async function settled(date, expected) {
    await until(() => app.evaluate((_, { date, expected }) => globalThis.__weatherEmptyCalls.some(call => call.date === date && call.state === expected), { date, expected }), `${date}: ${expected}`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function blank() {
    assert.equal(await page.locator('.weather-block').count(), 0, 'Home should leave the weather area empty when no usable result is available');
    assert.equal(await page.locator('.day-heading .weather-art,.day-heading .weather-message,.day-heading .weather-temperature').count(), 0);
    assert.doesNotMatch(await page.locator('.day-panel .day-heading').textContent(), /天气加载中|暂无天气|天气获取失败|IP 自动定位|自动定位中/);
  }
  async function control(value) { await app.evaluate((_, value) => { Object.assign(globalThis.__weatherEmptyControl, value); globalThis.__weatherEmptyCalls = []; }, value); }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'stage' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await ready(today, '16–25℃');
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      BrowserWindow.getAllWindows()[0].setSize(1500, 980); BrowserWindow.getAllWindows()[0].hide();
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      globalThis.__weatherEmptyCalls = []; globalThis.__weatherEmptyControl = { delay: 0, force: false };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call'); ipcMain.handle('workday:call', async (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) throw new Error('External operations blocked in weather-empty fixture');
        if (operation !== 'weather.query') return original(event, operation, input);
        const current = { date: input.date, state: 'pending' }; globalThis.__weatherEmptyCalls.push(current);
        const controls = { ...globalThis.__weatherEmptyControl };
        if (controls.delay) await new Promise(resolve => setTimeout(resolve, controls.delay));
        const result = await original(event, operation, { ...input, ...(controls.force ? { refresh: true } : {}) });
        current.state = result.ok ? result.value.status : 'error';
        return result;
      });
    });
    record('Successful synthetic weather displays its city and complete temperature range');

    await page.getByRole('button', { name: '上个月', exact: true }).click();
    const outside = page.locator('.month-grid .day:not(.outside)').first();
    const outsideDate = (await outside.getAttribute('aria-label')).slice(0, 10);
    await outside.click(); await settled(outsideDate, 'unavailable'); await blank();
    record('A completed out-of-range query leaves the Home weather area empty');
    await page.getByRole('button', { name: '今天', exact: true }).click(); await ready(today, '16–25℃');

    await control({ delay: 700 });
    await page.locator(`.day[aria-label^="${add(1)}"]`).click();
    await until(() => app.evaluate((_, date) => globalThis.__weatherEmptyCalls.some(call => call.date === date && call.state === 'pending'), add(1)), 'new date pending');
    await blank(); await settled(add(1), 'ready'); await ready(add(1), '17–26℃');
    record('Changing dates immediately clears the previous weather while the new query is pending, then displays the matching result');

    await control({ delay: 0, force: true });
    await app.evaluate(() => { globalThis.__weatherFixture.forecastQueue = [{ error: true }]; });
    await page.locator(`.day[aria-label^="${today}"]`).click(); await settled(today, 'error'); await blank();
    record('A completed provider failure renders no error copy, stale date content or illustration on Home');
    await control({ force: false });
    await page.locator(`.day[aria-label^="${add(1)}"]`).click(); await ready(add(1), '17–26℃');
    await page.getByRole('button', { name: '今天', exact: true }).click(); await ready(today, '16–25℃');
    record('Returning to today restores valid cached weather after a failed refresh');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.locator('.day-panel .day-heading').screenshot({ path: path.join(output, 'ready.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, checks, personalData: false, network: 'synthetic providers installed before entry', executable: await app.evaluate(() => process.execPath), dataDirectory: data }, null, 2));
    console.log(JSON.stringify({ passed: true, output, checks: checks.length }));
  } catch (error) {
    if (page && !page.isClosed()) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
