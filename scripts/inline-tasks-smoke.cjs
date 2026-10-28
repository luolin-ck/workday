const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-inline-tasks-'));
  const output = path.join(root, 'output/playwright/inline-tasks');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const checks = [], errors = [];
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) {
    for (let n = 0; n < 120; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  const call = async (op, input) => {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const all = async () => (await call('state.get', {})).tasks.filter(t => !t.deletedAt);
  const count = () => app.evaluate(() => globalThis.__inlineFixture.saves.length);
  const mode = value => app.evaluate((_, value) => { globalThis.__inlineFixture.mode = value; }, value);
  const release = value => app.evaluate((_, value) => { const f = globalThis.__inlineFixture; f.mode = value; f.release(); }, value);
  const draft = () => page.getByRole('textbox', { name: '新增待办内容', exact: true });
  const emptyArt = () => page.getByRole('img', { name: '暂无待办', exact: true });
  const add = () => page.getByRole('button', { name: '新增待办', exact: true });
  const row = id => page.locator(`.task-row[data-task-id="${id}"]`);
  const title = id => row(id).getByRole('textbox');
  async function newDraft(value) { await add().click(); await draft().waitFor(); await draft().fill(value); }
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.hide();
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('workday:call');
      const fixture = globalThis.__inlineFixture = { saves: [], mode: 'normal', blocked: [] };
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, input) => {
        if (['chat.send', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(op)) {
          fixture.blocked.push(op); return { ok: false, error: { code: 'TEST_BLOCKED', message: 'External operation disabled' } };
        }
        if (op === 'tasks.save') {
          fixture.saves.push(input);
          if (fixture.mode === 'hold') await new Promise(resolve => { fixture.release = resolve; });
          if (fixture.mode === 'fail') return { ok: false, error: { code: 'TEST_SAVE', message: '隔离保存失败，请重试' } };
        }
        return original(event, op, input);
      });
    });
    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await emptyArt().waitFor();
      await emptyArt().evaluate(image => image.decode());
      assert.equal(await page.locator('.day-empty').textContent(), '');
      for (const width of [1500, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await page.waitForFunction(width => innerWidth === width, width);
        await emptyArt().scrollIntoViewIfNeeded();
        const bounds = await emptyArt().evaluate(image => { const r = image.getBoundingClientRect(), p = image.closest('.task-list').getBoundingClientRect(); return { loaded: image.complete && image.naturalWidth > 0, width: r.width, inside: r.left >= p.left && r.right <= p.right, overflow: document.documentElement.scrollWidth > innerWidth }; });
        assert.ok(bounds.loaded && bounds.width <= 160 && bounds.inside && !bounds.overflow, JSON.stringify(bounds));
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
        await page.locator('.day-panel').screenshot({ path: path.join(output, `empty-${theme}-${width}.png`) });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      }
    }
    await setFixtureTheme(page, 'mono'); await emptyArt().waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
    record('Empty tasks use a loaded local illustration without visible copy in three themes and two widths, with no overflow');
    assert.equal(await page.locator('.calendar').getByRole('button', { name: '新增待办' }).count(), 0);
    assert.equal(await page.locator('.day-panel .task-add').getByRole('button', { name: '新增待办' }).count(), 1);
    await add().hover(); await page.getByRole('tooltip', { name: '新增待办', exact: true }).waitFor();
    await add().click();
    await until(() => draft().evaluate(el => el === document.activeElement), 'new row focused');
    assert.equal(await emptyArt().count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await draft().fill('   '); await draft().press('Enter');
    await draft().waitFor({ state: 'hidden' }); assert.equal(await count(), 0); assert.equal((await all()).length, 0);
    await emptyArt().waitFor();
    await newDraft('取消的新行'); await draft().press('Escape');
    await draft().waitFor({ state: 'hidden' }); assert.equal(await count(), 0);
    await emptyArt().waitFor();
    record('Only the panel-bottom plus opens a focused inline row; tooltip works, empty/cancelled drafts do not persist');

    await newDraft('  Enter 新增  '); await mode('hold'); await draft().press('Enter');
    await until(async () => await count() === 1, 'new save held');
    await draft().focus(); await draft().press('Enter');
    assert.equal(await count(), 1); assert.equal(await add().isDisabled(), true);
    await release('normal'); await draft().waitFor({ state: 'hidden' });
    let tasks = await all(); assert.equal(tasks.length, 1); assert.equal(tasks[0].title, 'Enter 新增');
    assert.equal(await emptyArt().count(), 0);
    const created = tasks[0], today = created.date;
    await newDraft('失焦新增'); await page.locator('.day-date h2').click(); await draft().waitFor({ state: 'hidden' });
    assert.equal(await count(), 2); assert.equal((await all()).length, 2);
    record('Enter and blur each save once, trim the title, and a pending request cannot create duplicates');

    await newDraft('中文输入');
    await draft().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
    assert.equal(await count(), 2); assert.equal(await draft().evaluate(el => el === document.activeElement), true);
    await mode('fail'); await draft().press('Enter');
    await page.locator('.task-new-row').getByText('隔离保存失败，请重试', { exact: false }).waitFor();
    assert.equal(await draft().inputValue(), '中文输入');
    await mode('normal'); await draft().focus(); await draft().press('Enter');
    await draft().waitFor({ state: 'hidden' }); assert.equal((await all()).filter(t => t.title === '中文输入').length, 1);
    record('IME confirmation does not submit; failed creation retains its input and retries without duplication');

    await newDraft('连续新增');
    const beforePlus = await count(); await add().click();
    await until(async () => (await all()).some(t => t.title === '连续新增'), 'plus saves current row');
    await until(async () => await draft().inputValue() === '' && await draft().evaluate(el => el === document.activeElement), 'plus opens the next focused row');
    assert.equal(await count(), beforePlus + 1); await draft().press('Escape');
    record('Clicking plus while entering a new task saves it once and leaves the next empty row ready');

    const directory = path.join(data, 'project'); await fs.mkdir(directory);
    const project = await call('projects.save', { name: '行内项目', description: '', directory });
    let base = await call('tasks.save', { id: created.id, expectedVersion: created.version, title: created.title, notes: '保留备注', date: today, dueDate: today, projectId: project.id, completed: false });
    await page.getByRole('button', { name: '刷新日历', exact: true }).click();
    await title(base.id).fill('修改后保留所有字段');
    let before = await count(); await title(base.id).press('Enter');
    await until(async () => (await all()).find(t => t.id === base.id).title === '修改后保留所有字段', 'existing title saved');
    let saved = (await all()).find(t => t.id === base.id);
    for (const key of ['notes', 'date', 'dueDate', 'projectId', 'completed']) assert.equal(saved[key], base[key]);
    assert.equal(saved.version, base.version + 1); assert.equal(await count(), before + 1);
    await title(base.id).fill(''); await title(base.id).press('Enter');
    await row(base.id).getByText('内容不能为空', { exact: true }).waitFor();
    assert.equal(await count(), before + 1); assert.equal(await title(base.id).inputValue(), '');
    await title(base.id).focus(); await title(base.id).press('Escape');
    assert.equal(await title(base.id).inputValue(), saved.title);
    record('Existing titles save with version checks, retain all other fields, and empty edits cannot erase saved content');

    await title(base.id).fill('保存失败不丢失'); await mode('hold'); await title(base.id).press('Enter');
    await until(async () => await count() === before + 2, 'existing save held');
    await title(base.id).focus(); await title(base.id).press('Escape');
    assert.equal(await title(base.id).inputValue(), '保存失败不丢失');
    await release('fail'); await row(base.id).getByText('隔离保存失败，请重试', { exact: false }).waitFor();
    assert.equal(await title(base.id).inputValue(), '保存失败不丢失');
    await mode('normal'); await title(base.id).press('Enter');
    await until(async () => (await all()).find(t => t.id === base.id).title === '保存失败不丢失', 'existing retry saved');
    record('Escape during a pending save does not discard edits; failed edits remain retryable inline');

    await title(base.id).fill('标题与完成一起保存'); before = await count(); await mode('hold');
    await row(base.id).getByRole('checkbox').click();
    await until(async () => await count() === before + 1, 'title save before checkbox');
    await release('normal');
    await until(async () => (await all()).find(t => t.id === base.id).completed, 'checkbox click survives blur save');
    saved = (await all()).find(t => t.id === base.id);
    assert.equal(saved.title, '标题与完成一起保存'); assert.equal(await count(), before + 2);
    assert.equal(saved.notes, base.notes); assert.equal(saved.projectId, project.id);
    record('A single completion click waits for the title save and uses its new version without dropping the action');

    await title(base.id).fill('项目切换后的标题'); before = await count(); await mode('hold');
    await row(base.id).locator('.task-project-picker').click();
    await page.getByRole('menuitem', { name: '空', exact: true }).click();
    await until(async () => await count() === before + 1, 'title save before project action');
    await release('normal');
    await until(async () => (await all()).find(t => t.id === base.id).projectId === null, 'project action survives pending save');
    saved = (await all()).find(t => t.id === base.id);
    assert.equal(saved.title, '项目切换后的标题'); assert.equal(saved.completed, true); assert.equal(await count(), before + 2);
    record('Project changes also wait for pending title edits and preserve completion and notes');

    await title(base.id).fill('版本冲突草稿');
    await call('tasks.save', { id: saved.id, expectedVersion: saved.version, title: '其他入口更新', notes: '新的备注', date: saved.date, dueDate: saved.dueDate, projectId: null, completed: true });
    await title(base.id).press('Enter');
    await row(base.id).locator('.mantine-InputWrapper-error').waitFor();
    assert.equal(await title(base.id).inputValue(), '版本冲突草稿');
    assert.equal((await all()).find(t => t.id === base.id).title, '其他入口更新');
    await title(base.id).focus(); await title(base.id).press('Enter');
    await until(async () => (await all()).find(t => t.id === base.id).title === '版本冲突草稿', 'explicit retry');
    assert.equal((await all()).find(t => t.id === base.id).notes, '新的备注');
    record('Concurrent changes reject stale edits, keep the draft, and explicit retry preserves the latest metadata');

    const nextDate = await page.locator('.day.selected').evaluate(el => el.nextElementSibling?.getAttribute('aria-label')?.slice(0, 10) || el.previousElementSibling.getAttribute('aria-label').slice(0, 10));
    await newDraft('日期切换草稿'); await mode('fail'); before = await count();
    await page.locator(`.day[aria-label^="${nextDate}"]`).click();
    await until(async () => await count() === before + 1, 'date-switch save attempted');
    assert.equal(await draft().count(), 0, 'draft is not shown on another date');
    await page.locator(`.day[aria-label^="${today}"]`).click();
    await draft().waitFor(); assert.equal(await draft().inputValue(), '日期切换草稿');
    await page.locator('.task-new-row').getByText('隔离保存失败，请重试', { exact: false }).waitFor();
    await mode('normal'); await draft().press('Enter'); await draft().waitFor({ state: 'hidden' });
    assert.equal((await all()).find(t => t.title === '日期切换草稿').date, today);
    record('A failed draft stays with its original selected date and saves to that date after retry');

    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    assert.equal((await all()).length, 5); assert.equal(await page.locator('.task-row[data-task-id]').count(), 5);
    assert.equal(await draft().count(), 0); assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => globalThis.__inlineFixture.blocked), []);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.locator('.conversation-column').screenshot({ path: path.join(output, 'inline-tasks.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    record('Saved rows survive reload without leftover drafts or renderer errors');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, dataDirectory: data, executable: await app.evaluate(() => process.execPath), personalData: false, modelRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
