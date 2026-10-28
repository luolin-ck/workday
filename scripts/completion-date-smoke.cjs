const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-completion-ui-'));
  const output = path.join(root, 'output/playwright', process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'completion-stage' : 'completion-date');
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const checks = [], errors = [];
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) { for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out: ' + label); }
  async function call(operation, input) { const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input }); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  const tasks = async () => (await call('state.get', {})).tasks;
  const row = id => page.locator(`.task-row[data-task-id="${id}"]`);
  const day = date => page.locator(`.day[aria-label^="${date}，"]`);
  async function openEditor(id) { await row(id).getByRole('button', { name: /^编辑与改期/ }).focus(); await page.keyboard.press('Enter'); const modal = page.getByRole('dialog'); await modal.waitFor(); return modal; }
  async function save(modal) { await modal.getByRole('button', { name: '保存', exact: true }).click(); await modal.waitFor({ state: 'hidden' }); }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1500, 980); window.hide();
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, operation, input) => { if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) throw new Error('External operations disabled in completion fixture'); return original(event, operation, input); });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const date = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    const before = await page.evaluate(date => { const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, date);
    const original = await call('tasks.save', { title: '合成完成日期事项', notes: '', date, projectId: null, completed: false });
    await row(original.id).waitFor(); let modal = await openEditor(original.id);
    assert.equal(await modal.getByLabel('完成日期', { exact: true }).count(), 0);
    await modal.getByRole('checkbox', { name: '已完成', exact: true }).click();
    const input = modal.getByLabel('完成日期', { exact: true }); assert.equal(await input.inputValue(), date);
    await input.fill(''); await modal.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await input.evaluate(element => element.validity.valueMissing), true); assert.equal((await tasks())[0].completed, false);
    await input.fill(before); await save(modal);
    await until(async () => (await tasks())[0].completedDate === before, 'backdated completion stored');
    assert.equal((await tasks())[0].date, date); await row(original.id).waitFor({ state: 'hidden' });
    assert.equal(await day(date).locator('.done-count').count(), 0);
    assert.equal(await day(before).locator('.done-count').textContent(), '1');
    record('Editor defaults to local today, requires a valid completion date, and moves the completed count without changing the planned date');

    await day(before).click(); await row(original.id).waitFor();
    await until(async () => (await page.locator('.composer-calendar').getAttribute('aria-label'))?.includes('全部 1 项'), 'Home completion day context count');
    modal = await openEditor(original.id); assert.equal(await modal.getByLabel('完成日期', { exact: true }).inputValue(), before);
    await modal.getByLabel('备注', { exact: true }).fill('合成备注更新'); await save(modal);
    assert.equal((await tasks())[0].completedDate, before);
    await page.reload(); await day(before).click(); await row(original.id).waitFor(); modal = await openEditor(original.id);
    assert.equal(await modal.getByLabel('完成日期', { exact: true }).inputValue(), before);
    record('Completion date persists through ordinary edits, reload, the selected-day list, and Home context count');

    for (const width of [400, 340]) {
      await page.addStyleTag({ content: `.modal{width:${width}px!important;max-width:${width}px!important}` });
      const bounds = await modal.locator('.task-completion-field').evaluate(element => {
        const a = element.querySelector('.check').getBoundingClientRect(), b = element.querySelector('input[type="date"]').getBoundingClientRect(), r = element.getBoundingClientRect();
        return { offset: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2), overlap: a.right > b.left, inside: b.right <= r.right + 1, overflow: element.scrollWidth > element.clientWidth };
      });
      assert.ok(bounds.offset < 1 && !bounds.overlap && bounds.inside && !bounds.overflow, JSON.stringify(bounds));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await modal.screenshot({ path: path.join(output, `modal-${width}.png`) });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    }
    record('At 400px and 340px modal widths the completion checkbox and date stay on one row with even alignment');
    await modal.getByLabel('完成日期', { exact: true }).fill(date); await save(modal);
    await until(async () => (await tasks())[0].completedDate === date, 'completion moved to today'); await row(original.id).waitFor({ state: 'hidden' });
    assert.equal(await day(before).locator('.done-count').count(), 0); assert.equal(await day(date).locator('.done-count').textContent(), '1');
    await day(date).click(); await row(original.id).waitFor(); await row(original.id).getByRole('checkbox').click();
    await until(async () => !(await tasks())[0].completed, 'reopened'); assert.equal((await tasks())[0].completedDate, null); assert.equal((await tasks())[0].date, date);
    assert.equal(await day(date).locator('.done-count').count(), 0); assert.equal(await day(date).locator('.pending-count').textContent(), '1');
    await row(original.id).getByRole('checkbox').click(); await until(async () => (await tasks())[0].completedDate === date, 'inline completion today');
    record('Changing completion date updates both day counts; reopening clears the date and inline completion uses today');
    assert.deepEqual(errors, []); assert.deepEqual(await app.evaluate(() => globalThis.__priorityNotifications.calls.flat()), []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, executable: await app.evaluate(() => process.execPath), personalData: false, modelRequests: 0, nativeNotifications: false, dataDirectory: data }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {}); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); } throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
