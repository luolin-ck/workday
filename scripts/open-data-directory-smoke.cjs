const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-open-data-'));
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `open-data-directory-${kind}`);
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [];
  let app, page;
  async function until(check, label) {
    for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain, shell }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1440, 980); window.hide();
      globalThis.__openDataFixture = { paths: [], result: '', externalOperations: [] };
      shell.openPath = async directory => {
        globalThis.__openDataFixture.paths.push(directory);
        return globalThis.__openDataFixture.result;
      };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) {
          globalThis.__openDataFixture.externalOperations.push(operation);
          throw new Error('External operations disabled in open-data fixture');
        }
        return original(event, operation, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const state = await page.evaluate(() => window.workday.call('state.get', {}));
    assert.equal(state.ok, true); assert.equal(state.value.dataDirectory, data);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    const card = page.locator('.data-settings article').filter({ has: page.getByRole('heading', { name: '本地业务数据', exact: true }) });
    const open = card.getByRole('button', { name: '打开', exact: true });
    await open.waitFor(); assert.equal(await card.count(), 1);
    assert.ok((await card.innerText()).includes(data));
    const alert = page.locator('.notification[role="alert"]');
    assert.equal(await alert.count(), 0);
    await open.click();
    await until(async () => (await app.evaluate(() => globalThis.__openDataFixture.paths)).length === 1 && !await open.isDisabled(), 'successful open completes');
    assert.deepEqual(await app.evaluate(() => globalThis.__openDataFixture.paths), [data]);
    assert.equal(await alert.count(), 0, 'Successful opening should not add a message toast');
    record('The local business-data card opens the actual isolated dataDirectory through shell.openPath, without a success toast');

    const rejected = await page.evaluate(() => window.workday.call('data.openDirectory', { path: '/tmp/unrequested-directory' }));
    assert.equal(rejected.ok, false, 'Renderer-provided paths must be rejected');
    assert.deepEqual(await app.evaluate(() => globalThis.__openDataFixture.paths), [data]);
    record('The no-argument operation rejects an injected path before invoking the native opener');

    await app.evaluate(() => { globalThis.__openDataFixture.result = 'fixture native failure detail'; });
    await open.click(); await alert.waitFor();
    assert.match(await alert.innerText(), /无法打开数据文件夹/);
    assert.doesNotMatch(await alert.innerText(), /fixture native failure detail/);
    await until(async () => !await open.isDisabled(), 'failed open releases button');
    assert.deepEqual(await app.evaluate(() => globalThis.__openDataFixture.paths), [data, data]);
    record('A native error string becomes a friendly error message and the open control becomes available again');

    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await app.evaluate(() => { globalThis.__openDataFixture.result = ''; });
    await open.click();
    await until(async () => (await app.evaluate(() => globalThis.__openDataFixture.paths)).length === 3 && !await open.isDisabled(), 'retry completes');
    assert.deepEqual(await app.evaluate(() => globalThis.__openDataFixture.paths), [data, data, data]);
    assert.equal(await alert.count(), 0);
    record('Retry opens the same data directory successfully without a new toast');

    assert.deepEqual(await app.evaluate(() => globalThis.__openDataFixture.externalOperations), []);
    assert.deepEqual(errors, []);
    await page.mouse.move(0, 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await card.screenshot({ path: path.join(output, 'data-card.png'), animations: 'disabled' });
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      passed: true, kind, checks, executable: await app.evaluate(() => process.execPath),
      dataDirectory: data, personalData: false, personalCredentials: false, modelRequests: 0,
      nativeOpener: 'shell.openPath intercepted; no real folders opened', realFinderVerified: false
    }, null, 2));
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
