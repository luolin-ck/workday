const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { setFixtureTheme } = require('./appearance-fixture.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-tabs-'));
  const output = path.join(root, 'output/playwright', process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'tabs-style-stage' : 'tabs-style-source');
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [];
  let app, page;
  const styleOf = tab => tab.evaluate(element => {
    const s = getComputedStyle(element), r = element.getBoundingClientRect();
    return { font: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, padding: s.padding,
      radius: s.borderRadius, border: s.borderWidth, background: s.backgroundColor,
      color: s.color, shadow: s.boxShadow, height: r.height };
  });
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const w = BrowserWindow.getAllWindows()[0]; w.hide(); w.webContents.setBackgroundThrottling(false);
      const original = ipcMain._invokeHandlers.get('workday:call');
      globalThis.__tabsExternalCalls = [];
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        if (['chat.send', 'sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call'].includes(op)) {
          globalThis.__tabsExternalCalls.push(op); throw new Error('External calls blocked in tab fixture');
        }
        return original(event, op, input);
      });
    });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await page.evaluate(async () => {
      const result = await window.workday.call('sources.save', { name: '示例模型源', baseUrl: 'https://fixture.invalid/v1',
        models: Array.from({ length: 8 }, (_, i) => ({ id: `model-${i + 1}`, name: `model-${i + 1}`, supportsTools: false })) });
      if (!result.ok) throw new Error('Could not create isolated source fixture');
    });
    for (const theme of ['mono', 'blue', 'custom']) {
      await setFixtureTheme(page, theme);
      for (const width of [1440, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await page.waitForFunction(width => innerWidth === width, width);
        const pages = [];
        for (const [name, label] of [['设置', '设置分类'], ['插件', '插件类型']]) {
          await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name, exact: true }).click();
          const list = page.getByRole('tablist', { name: label });
          const tabs = list.getByRole('tab');
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
          await tabs.first().click(); await page.mouse.move(0, 0);
          const selected = await styleOf(tabs.first()), idle = await styleOf(tabs.nth(1));
          await tabs.first().hover();
          assert.deepEqual(await styleOf(tabs.first()), selected, 'Hover must preserve the selected tab appearance');
          await page.mouse.move(0, 0);
          const bounds = await list.evaluate(element => {
            const s = getComputedStyle(element), r = element.getBoundingClientRect();
            const rects = [...element.children].filter(e => e.getAttribute('role') === 'tab').map(e => e.getBoundingClientRect());
            return { gap: s.gap, padding: s.padding, background: s.backgroundColor, radius: s.borderRadius,
              border: s.borderWidth, before: getComputedStyle(element, '::before').borderBottomWidth,
              fits: r.left >= 0 && r.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1,
              sameRow: rects.every(t => Math.abs(t.top - rects[0].top) <= 1),
              pageOverflow: element.closest('.page').scrollWidth > element.closest('.page').clientWidth + 1 };
          });
          await tabs.nth(1).hover();
          await page.waitForFunction(() => {
            const tab = document.querySelector('.tabs [role=tab]:hover:not([data-active])');
            if (!tab) return false;
            const expected = getComputedStyle(document.documentElement).getPropertyValue('--button-hover').trim();
            const hex = /^#([a-f\d]{6})$/i.exec(expected);
            const rgb = hex && `rgb(${[0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).join(', ')})`;
            return getComputedStyle(tab).backgroundColor === (rgb || expected);
          });
          const hover = await styleOf(tabs.nth(1));
          assert.notEqual(hover.background, idle.background, 'Hover must show the shared hover surface');
          assert.equal(hover.height, idle.height, 'Hover must not shift the row');
          await page.mouse.move(0, 0); await tabs.first().focus();
          await page.keyboard.press('ArrowRight');
          assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true', 'ArrowRight must select the next tab');
          assert.equal(await tabs.nth(1).evaluate(e => document.activeElement === e), true);
          const focus = await tabs.nth(1).evaluate(e => ({ visible: e.matches(':focus-visible'), width: getComputedStyle(e).outlineWidth }));
          assert.ok(focus.visible && parseFloat(focus.width) > 0, 'Keyboard focus must remain visible');
          await page.keyboard.press('ArrowLeft');
          assert.equal(await tabs.first().getAttribute('aria-selected'), 'true', 'ArrowLeft must select the previous tab');
          for (let i = 0; i < await tabs.count(); i++) {
            await tabs.nth(i).click();
            const panel = page.getByRole('tabpanel');
            assert.equal(await panel.count(), 1);
            assert.equal(await panel.getAttribute('id'), await tabs.nth(i).getAttribute('aria-controls'));
          }
          await tabs.first().click(); await page.mouse.move(0, 0);
          pages.push({ name, selected, idle, hover, bounds });
          if (theme === 'mono') {
            await page.screenshot({ path: path.join(output, `${name}-${width}.png`), animations: 'disabled' });
          }
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        }
        for (const state of ['selected', 'idle', 'hover']) {
          assert.deepEqual(pages[0][state], pages[1][state], `Settings and plugins must share ${state} tab styling`);
        }
        for (const p of pages) {
          assert.ok(p.bounds.fits && p.bounds.sameRow && !p.bounds.pageOverflow, JSON.stringify(p.bounds));
          assert.equal(parseFloat(p.selected.border), 0, 'Selected tabs should not have an underline');
          assert.equal(parseFloat(p.bounds.border), 0, 'The tab strip should not draw a full-width divider');
          assert.equal(parseFloat(p.bounds.before), 0, 'Mantine must not add another divider');
          assert.ok(parseFloat(p.selected.radius) > 0 && parseFloat(p.bounds.radius) > 0, 'Tabs should have shared rounded surfaces');
          assert.ok(parseFloat(p.idle.padding.split(' ').at(-1)) > 0, 'Tab labels need horizontal breathing room');
          assert.notEqual(p.selected.background, p.idle.background, 'Selection must be visible without an underline');
        }
        checks.push({ theme, width, pages }); console.log(JSON.stringify({ passed: true, theme, width }));
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => globalThis.__tabsExternalCalls), []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, dataDirectory: data, personalData: false, externalRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, cases: checks.length, output }));
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
