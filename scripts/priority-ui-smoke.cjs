const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-priority-ui-'));
  const output = path.join(root, 'output/playwright', process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'task-corner-controls-stage' : 'task-corner-controls-source');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [];
  let app, page;
  const record = message => { checks.push(message); console.log(JSON.stringify({ check: checks.length, message })); };
  async function until(check, label) {
    for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  }
  async function call(operation, input) {
    const result = await page.evaluate(({ operation, input }) => window.workday.call(operation, input), { operation, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  const tasks = async () => (await call('state.get', {})).tasks.filter(task => !task.deletedAt);
  const row = id => page.locator(`.task-row[data-task-id="${id}"]`);
  const priority = id => row(id).locator('.task-priority-picker');
  const notifications = () => app.evaluate(() => globalThis.__priorityNotifications.calls.flat());
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    assert.equal(await app.evaluate(() => Array.isArray(globalThis.__priorityNotifications?.calls)), true, 'notification stub must be installed before entry');
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1500, 980); window.hide();
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, operation, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'mcp.call', 'schedules.run'].includes(operation)) throw new Error('External operations disabled in priority fixture');
        return original(event, operation, input);
      });
    });
    await page.getByRole('button', { name: '新增待办', exact: true }).click();
    await page.getByRole('textbox', { name: '新增待办内容', exact: true }).fill('合成优先级事项');
    await page.getByRole('textbox', { name: '新增待办内容', exact: true }).press('Enter');
    await until(async () => (await tasks()).length === 1, 'inline task saved');
    const original = (await tasks())[0];
    assert.equal(original.priority, 'P2');
    await until(async () => await priority(original.id).textContent() === 'P2', 'default priority badge');
    assert.deepEqual(await notifications(), []);
    record('Inline creation defaults to a visible P2 badge without an OS notification');

    await priority(original.id).focus(); await priority(original.id).press('Enter');
    const p0 = page.getByRole('menuitem', { name: 'P0', exact: true }); await p0.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'));
    await page.keyboard.press('ArrowDown');
    await until(() => p0.evaluate(element => element === document.activeElement), 'keyboard menu focuses first priority');
    await p0.press('Enter');
    await until(async () => (await tasks())[0].priority === 'P0', 'keyboard P0 save');
    await until(async () => (await notifications()).some(task => task.id === original.id), 'P0 fake desktop notification');
    assert.ok((await notifications()).every(task => task.priority === 'P0'));
    const notificationCount = (await notifications()).filter(task => task.id === original.id).length;
    record('Keyboard opens the menu and saves P0; the isolated notification stub receives only P0');

    await row(original.id).getByRole('textbox').fill('修改后合成事项');
    await row(original.id).getByRole('textbox').press('Enter');
    await until(async () => (await tasks())[0].title === '修改后合成事项', 'title saved');
    assert.equal((await tasks())[0].priority, 'P0');
    await row(original.id).getByRole('checkbox').click();
    await until(async () => (await tasks())[0].completed, 'complete saved');
    assert.equal((await tasks())[0].priority, 'P0');
    await row(original.id).getByRole('checkbox').click();
    await until(async () => !(await tasks())[0].completed, 'reopen saved');
    assert.equal((await tasks())[0].priority, 'P0');
    assert.equal((await notifications()).filter(task => task.id === original.id).length, notificationCount);
    record('Title/completion edits preserve priority and do not repeat the same-day P0 notification');

    await row(original.id).getByRole('button', { name: /^编辑与改期/ }).focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: '优先级', exact: true }).inputValue(), 'P0');
    await dialog.getByRole('combobox', { name: '优先级', exact: true }).selectOption('P1');
    await dialog.getByLabel('截止日期', { exact: true }).fill(original.date);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await tasks())[0].priority === 'P1', 'editor priority save');
    const saved = (await tasks())[0]; assert.equal(saved.dueDate, original.date); assert.equal(saved.title, '修改后合成事项');
    const positions = await row(original.id).evaluate(element => {
      const actions = [...element.querySelector('.task-actions').children];
      return ['.task-deadline', '.task-priority-picker', '.task-project-picker'].map(selector => actions.findIndex(child => child.matches(selector) || child.querySelector(selector)));
    });
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], JSON.stringify(positions));
    record('TaskEditor reads and saves priority together with the due date; inline metadata stays ordered as deadline, priority, project, with edit/delete as corner actions');

    const directory = path.join(data, 'project'); await fs.mkdir(directory);
    const project = await call('projects.save', { name: '合成项目', description: '', directory });
    await row(original.id).locator('.task-project-picker').click();
    await page.getByRole('menuitem', { name: '合成项目', exact: true }).click();
    await until(async () => (await tasks())[0].projectId === project.id, 'project saved');
    assert.equal((await tasks())[0].priority, 'P1');
    await priority(original.id).click();
    await page.getByRole('menuitem', { name: 'P2', exact: true }).click();
    await until(async () => (await tasks())[0].priority === 'P2', 'P2 selected');
    assert.equal((await tasks())[0].projectId, project.id);
    record('Project selection preserves P1; priority selection preserves project and other metadata');

    await row(original.id).getByRole('textbox').fill('合成很长的事项标题用于验证单行省略和操作区间距'.repeat(5));
    await row(original.id).getByRole('textbox').press('Enter');
    for (const theme of ['mono', 'custom', 'blue']) {
      await setFixtureTheme(page, theme); await priority(original.id).waitFor();
      for (const width of [1500, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width);
        const bounds = await row(original.id).evaluate(element => {
          const rect = element.getBoundingClientRect(), input = element.querySelector('input:not([type="checkbox"])'), style = getComputedStyle(input);
          const actions = [...element.querySelector('.task-actions').children].map(child => { const r = child.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; });
          return { overflow: document.documentElement.scrollWidth > innerWidth, inputWidth: input.getBoundingClientRect().width, ellipsis: style.textOverflow, nowrap: style.whiteSpace, inside: actions.every(item => item.left >= rect.left && item.right <= rect.right + 1), centers: actions.map(item => item.left + item.width / 2), actionWidth: element.querySelector('.task-actions').getBoundingClientRect().width, iconWidths: [...element.querySelectorAll('.task-deadline svg,.task-edit-action svg,.task-delete-action svg')].map(icon => icon.getBoundingClientRect().width) };
        });
        assert.ok(!bounds.overflow && bounds.inside && bounds.inputWidth > 0, JSON.stringify(bounds));
        assert.equal(bounds.ellipsis, 'ellipsis'); assert.equal(bounds.nowrap, 'nowrap');
        const gaps = bounds.centers.slice(1).map((value, index) => value - bounds.centers[index]);
        assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, JSON.stringify(bounds));
        assert.ok(bounds.actionWidth <= 86, `Deadline, priority and project should fit within 86px: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.iconWidths.length === 3 && bounds.iconWidths.every(width => width <= 14), `Task icons should be compact: ${JSON.stringify(bounds)}`);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
        await row(original.id).screenshot({ path: path.join(output, `${theme}-${width}.png`) });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      }
    }
    assert.equal((await tasks())[0].priority, 'P2');
    assert.equal((await notifications()).filter(task => task.id === original.id).length, notificationCount);
    assert.deepEqual(errors, []);
    record('Three themes and two widths keep long titles single-line, controls equally spaced, and saved priority across reload');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, personalData: false, systemNotifications: false, modelRequests: 0, dataDirectory: data, executable: await app.evaluate(() => process.execPath) }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
