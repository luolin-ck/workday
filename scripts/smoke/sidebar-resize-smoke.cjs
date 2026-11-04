// Isolated Electron acceptance for the project sidebar's user-controlled width.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('../fixtures/electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const appRoot = process.env.WORKDAY_APP_ROOT || root;
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/sidebar-resize-' + kind));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-sidebar-resize-')));
  const startedAt = new Date().toISOString(), checks = [], frames = [], measurements = [], errors = [];
  let app, page;
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const until = async (test, label) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error('Timed out: ' + label);
  };
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} versus ${expected}`);
  const call = async (op, input = {}) => {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const separator = () => page.getByRole('separator', { name: '调整项目侧栏宽度', exact: true });
  const width = async () => (await page.locator('.workspace.projects > .primary-area').boundingBox()).width;
  const frame = async name => {
    const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64')); frames.push(name);
  };
  const bounds = async () => {
    const element = separator();
    const min = Number(await element.getAttribute('aria-valuemin'));
    const max = Number(await element.getAttribute('aria-valuemax'));
    const now = Number(await element.getAttribute('aria-valuenow'));
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && min >= 140 && max > min, 'Meaningful accessible resize bounds');
    near(await width(), now, 'Accessible value matches actual sidebar width');
    return { min, max, now };
  };
  const dragTo = async target => {
    const box = await separator().boundingBox(); assert.ok(box, 'Resize separator is visible');
    const x = box.x + box.width / 2, y = box.y + Math.min(120, box.height / 2);
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(target, y, { steps: 8 }); await page.mouse.up();
  };
  const resizeWindow = async value => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), value);
    await until(() => page.evaluate(w => innerWidth === w, value), 'window width ' + value);
  };
  const enterProjects = () => page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: kind === 'source' ? [appRoot] : [], env, timeout: 30000
    }, { mockHolidays: true, keychain: true });
    page = await app.firstWindow(); page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow, ipcMain }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Data isolation mismatch');
      const window = BrowserWindow.getAllWindows()[0]; window.setSize(1400, 900); window.showInactive(); window.webContents.setBackgroundThrottling(false);
      globalThis.__resizeFixture = { blocked: [] };
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save'].includes(op)) {
          globalThis.__resizeFixture.blocked.push(op); throw Error('External operation blocked');
        }
        return original(event, op, input);
      });
    }, data);
    await page.route(/^https?:\/\//, route => { errors.push('Unexpected renderer network'); return route.abort(); });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const chat = await call('conversations.create', { title: '侧栏宽度验收对话：较长标题保持省略', projectId: null, date: null, model: null });
    await enterProjects();
    await page.locator('.conversation-list').getByRole('button', { name: chat.title, exact: true }).click();
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('拖动侧栏不会丢失此草稿');
    assert.equal(await separator().count(), 1, 'BUSINESS RED: project sidebar requires an accessible draggable separator');
    await separator().waitFor({ state: 'visible' });
    assert.equal(await separator().getAttribute('aria-orientation'), 'vertical');
    assert.equal(await separator().getAttribute('tabindex'), '0');
    assert.ok(['col-resize', 'ew-resize'].includes(await separator().evaluate(e => getComputedStyle(e).cursor)));
    const initial = await width(), box = await separator().boundingBox();
    const panel = await page.locator('.workspace.projects > .primary-area').boundingBox();
    near(box.x + box.width / 2, panel.x + panel.width, 'Separator sits on the sidebar boundary');
    checks.push('Accessible, keyboard-focusable separator is positioned on the sidebar boundary');

    await dragTo(box.x + box.width / 2 + 80);
    await until(async () => Math.abs(await width() - initial - 80) <= 2, 'drag right grows sidebar');
    const grown = await width(); await page.mouse.move(900, 300); near(await width(), grown, 'Mouse release ends resizing');
    const widerBox = await separator().boundingBox(); await dragTo(widerBox.x + widerBox.width / 2 - 40);
    near(await width(), initial + 40, 'Drag left shrinks sidebar');
    assert.equal(await input.inputValue(), '拖动侧栏不会丢失此草稿');
    assert.equal(await page.locator('.conversation-list').getByRole('button', { name: chat.title, exact: true }).getAttribute('aria-current'), 'page');
    checks.push('Pointer drag works in both directions, ends on release and preserves the active chat and draft');

    for (const cancellation of ['Escape', 'pointercancel']) {
      const before = await width(), handle = separator(), rect = await handle.boundingBox();
      const x = rect.x + rect.width / 2, y = rect.y + Math.min(120, rect.height / 2);
      // Observe the real pointer ID instead of assuming Chromium's mouse pointer ID.
      await handle.evaluate(element => element.addEventListener('pointerdown', event => { element.__resizeTestPointerId = event.pointerId; }, { once: true }));
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 45, y, { steps: 4 });
      await until(async () => await width() > before + 20, cancellation + ' scenario starts an active drag');
      assert.equal(await page.locator('[data-resizing-sidebar]').count(), 1, 'Active drag advertises resizing state');
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else {
        const pointerId = await handle.evaluate(element => element.__resizeTestPointerId);
        assert.ok(Number.isInteger(pointerId), 'Captured pointer ID is available');
        await handle.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, bubbles: true });
      }
      await until(async () => Math.abs(await width() - before) <= 2, cancellation + ' restores the pre-drag width');
      assert.equal(await page.locator('[data-resizing-sidebar]').count(), 0, cancellation + ' clears resizing state');
      await page.mouse.move(x + 100, y); near(await width(), before, cancellation + ' ignores subsequent movement');
      await page.mouse.up();
      await handle.evaluate(element => { delete element.__resizeTestPointerId; });
      assert.equal(await input.inputValue(), '拖动侧栏不会丢失此草稿');
    }
    checks.push('Escape and pointer cancellation restore width, clear drag state and ignore later pointer movement');

    const navigationBox = await separator().boundingBox(), navigationWidth = await width();
    const navigationX = navigationBox.x + navigationBox.width / 2, navigationY = navigationBox.y + Math.min(120, navigationBox.height / 2);
    await page.mouse.move(navigationX, navigationY); await page.mouse.down();
    await page.mouse.move(navigationX + 45, navigationY, { steps: 4 });
    await until(async () => await width() > navigationWidth + 20, 'navigation scenario starts an active drag');
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: 'Home', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.locator('.workspace.home').waitFor();
    assert.equal(await page.locator('[data-resizing-sidebar]').count(), 0, 'Leaving Projects clears drag state');
    await page.mouse.move(900, 300); await page.mouse.up();
    await enterProjects();
    await page.locator('.conversation-list').getByRole('button', { name: chat.title, exact: true }).click();
    assert.equal(await page.locator('[data-resizing-sidebar]').count(), 0, 'Returning to Projects does not resume the old drag');
    const afterNavigation = await width(); await page.mouse.move(1000, 350); near(await width(), afterNavigation, 'Navigation cleans up pointer tracking');
    assert.equal(await input.inputValue(), '拖动侧栏不会丢失此草稿');
    checks.push('Keyboard navigation during a held drag cleans up resizing and preserves the original chat draft');

    await dragTo(1398); let limits = await bounds(); near(await width(), limits.max, 'Right drag clamps at maximum');
    await dragTo(0); limits = await bounds(); near(await width(), limits.min, 'Left drag clamps at minimum');
    await separator().focus(); await separator().press('End'); limits = await bounds(); near(await width(), limits.max, 'End reaches maximum');
    await separator().press('ArrowLeft'); assert.ok(await width() < limits.max, 'ArrowLeft reduces width');
    await separator().press('Home'); limits = await bounds(); near(await width(), limits.min, 'Home reaches minimum');
    await separator().press('ArrowRight'); assert.ok(await width() > limits.min, 'ArrowRight increases width');
    await separator().dblclick(); near(await width(), initial, 'Double click restores default width');
    checks.push('Pointer and keyboard obey limits; Home/End, arrows and double-click reset work');

    const defaultBox = await separator().boundingBox(); await dragTo(defaultBox.x + defaultBox.width / 2 + 100);
    const preferred = await width(); assert.ok(preferred > initial, 'Persistence scenario uses a changed width');
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await enterProjects();
    near(await width(), preferred, 'Reload restores preferred sidebar width');
    await frame('sidebar-resized.png'); checks.push('Preferred width survives renderer reload');

    await separator().press('End'); const widePreference = await width();
    await resizeWindow(660); await until(async () => (await bounds()).max < widePreference, 'narrow viewport limits width');
    const narrow = await bounds(), actual = await width(); assert.ok(actual <= narrow.max + 2);
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.workspace.projects'), chat = main.querySelector('.conversation-column');
      return { viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, mainWidth: main.getBoundingClientRect().width, chatWidth: chat.getBoundingClientRect().width };
    });
    assert.equal(layout.overflow, false, 'No horizontal page overflow in a narrow window');
    assert.ok(layout.chatWidth >= 250, 'Narrow window keeps usable conversation space');
    measurements.push({ initial, preferred, widePreference, narrow, layout });
    await frame('sidebar-narrow.png'); await resizeWindow(1400); near(await width(), widePreference, 'Returning to a wide window restores user preference');
    checks.push('Narrow window preserves usable conversation space without overwriting the wider preference');

    const isolation = await app.evaluate(() => ({ blocked: globalThis.__resizeFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls }));
    assert.deepEqual(isolation.blocked, []); assert.equal(isolation.nativeCalls, 0); assert.equal(isolation.credentialCalls, 0); assert.deepEqual(errors, []);
    const runtime = await app.evaluate(({ app }, expected) => ({ app: app.getAppPath(), executable: app.getPath('exe'), dataDirectoryVerified: app.getPath('userData') === expected }), data);
    assert.ok(runtime.dataDirectoryVerified);
    const result = { passed: true, kind, startedAt, completedAt: new Date().toISOString(), runtime, checks, frames, measurements, isolation, errors, personalData: false, realModel: false, realCredentials: false, scriptSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex') };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page) await frame('failure.png').catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, frames, errors }, null, 2)); throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.rm(data, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
