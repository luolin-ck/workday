const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

// Compare real renderer output against a baseline of the current theme set, using isolated fixtures.
async function main() {
  const root = path.resolve(__dirname, '..');
  const mode = process.argv[2] || 'compare';
  assert.ok(['baseline', 'compare', 'custom'].includes(mode), 'usage: theme-config-smoke.cjs baseline|compare|custom');
  const output = path.join(root, 'test-results');
  const baselineFile = path.join(output, 'theme-config-baseline-v2.json');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-theme-config-'));
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const snapshots = {}, errors = [];
  let app, page;
  const nav = name => page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name, exact: true });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const call = async (op, input) => {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  async function settings() { await nav('设置').click(); await page.getByRole('tab', { name: '主题', exact: true }).click(); }
  async function resize(width, height) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height]);
    await settle();
  }
  async function screenshot(name) {
    await fs.mkdir(output, { recursive: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    try { await page.screenshot({ path: path.join(output, name), animations: 'disabled' }); }
    finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide()); }
  }
  async function capture(key, selectors, keepHover = false) {
    if (!keepHover) await page.mouse.move(0, 0);
    await settle();
    snapshots[key] = await page.evaluate(selectors => Object.fromEntries([...Object.entries(selectors).map(([name, selector]) => {
      const el = document.querySelector(selector);
      if (!el) throw Error('Missing baseline element ' + name + ': ' + selector);
      const css = getComputedStyle(el), rect = el.getBoundingClientRect();
      const properties = ['color', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'borderColor', 'borderWidth', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'boxShadow', 'opacity', 'colorScheme'];
      return [name, { style: Object.fromEntries(properties.map(p => [p, css[p]])), geometry: { width: rect.width, height: rect.height, x: rect.x, y: rect.y } }];
    }), ['viewport', { style: {}, geometry: { width: innerWidth, height: innerHeight, x: 0, y: 0 } }]]), selectors);
  }
  const home = {
    root: 'html', canvas: '.app-shell', calendar: '.calendar', title: '.calendar h1', grid: '.month-grid',
    selectedDay: '.day[aria-pressed="true"]', taskCounts: '.day[aria-pressed="true"] .day-tasks',
    panel: '.day-panel', row: '.task-row', taskInput: '.task-title input', checkbox: '.task-row .mantine-Checkbox-input',
    project: '.task-project-picker', edit: '.task-row button[aria-label^="编辑与改期"]', add: '.task-add button',
    composer: '.composer-input', textarea: '.composer-input textarea', nav: 'nav button[aria-label="Home"]'
  };
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.hide(); });
    await nav('Home').waitFor();
    await resize(1500, 800);
    const today = await page.evaluate(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()));
    await call('tasks.save', { title: '主题配置验证待办', notes: '隔离验证备注', date: today, dueDate: today, projectId: null, completed: false });
    await call('tasks.save', { title: '主题配置完成记录', notes: '', date: today, dueDate: null, projectId: null, completed: true });
    const directory = path.join(data, 'theme-project'); await fs.mkdir(directory);
    await call('projects.save', { name: '主题配置验证项目', description: '', directory });
    await page.reload(); await nav('Home').waitFor();
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
    if (mode === 'custom') { await verifyCustomTheme(); return; }
    for (const [theme, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await settings(); await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
      await capture(theme + '/settings', { panel: '.appearance-settings', choice: '.theme-option[aria-pressed="true"]', preview: '.theme-option[aria-pressed="true"] .theme-preview', previewPanel: '.theme-option[aria-pressed="true"] .theme-preview>:nth-child(2)', previewAccent: '.theme-option[aria-pressed="true"] .theme-preview>:nth-child(3)', button: '.background-settings button', tabs: '.mantine-Tabs-list' });
      await nav('Home').click(); await capture(theme + '/home', home);
      await nav('Home').hover(); await page.getByRole('tooltip', { name: 'Home', exact: true }).waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="tooltip"]')).opacity === '1');
      await capture(theme + '/tooltip', { tooltip: '[role="tooltip"]' }, true);
      await page.mouse.move(0, 0); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '编辑与改期 主题配置验证待办', exact: true }).focus(); await page.keyboard.press('Enter');
      const modal = page.getByRole('dialog', { name: '编辑待办', exact: true }); await modal.waitFor();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="dialog"]')).opacity === '1');
      await capture(theme + '/modal', { modal: '[role="dialog"]', title: '.mantine-Modal-title', header: '.modal-header', body: '.modal-body', footer: '.modal-footer', input: '.modal-body input', button: '.modal-footer button[type="submit"]' });
      await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
      await nav('项目').click();
      await capture(theme + '/projects', { sidebar: '.project-page', newChat: '.project-new-chat', heading: '.project-sidebar-heading', group: '.project-group-heading', toggle: '.project-toggle', project: '.project-select', action: '.project-more' });
      await page.getByRole('button', { name: '项目操作 主题配置验证项目', exact: true }).click();
      await page.getByRole('menu').waitFor(); await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="menu"]')).opacity === '1');
      await capture(theme + '/menu', { menu: '[role="menu"]', item: '[role="menuitem"]' });
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
      await settings();
      const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#7864ab'; ctx.fillRect(0, 0, 2, 2); return canvas.toDataURL(); });
      await page.getByLabel('上传背景图片', { exact: false }).setInputFiles({ name: 'theme.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
      await page.waitForFunction(() => document.documentElement.dataset.background === 'true');
      await nav('Home').click(); await capture(theme + '/background', { canvas: '.app-shell', panel: '.day-panel', calendar: '.calendar', composer: '.composer-input' });
      await settings(); await page.getByRole('button', { name: '移除背景图片', exact: true }).click();
      await page.waitForFunction(() => !document.documentElement.dataset.background);
      await nav('Home').click();
      await resize(660, 720); await capture(theme + '/narrow', { calendar: '.calendar', grid: '.month-grid', panel: '.day-panel', row: '.task-row', composer: '.composer-input' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await resize(1500, 800);
      console.log(theme + ': captured settings, Home, portal, tooltip, projects/menu, background and narrow layout');
    }
    assert.deepEqual(errors, []);
    await fs.mkdir(output, { recursive: true });
    if (mode === 'baseline') {
      await fs.writeFile(baselineFile, JSON.stringify({ schemaVersion: 2, themes: ['custom', 'mono', 'blue'], date: today, snapshots }, null, 2));
      console.log('Baseline saved: ' + baselineFile);
    } else {
      const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
      assert.equal(baseline.schemaVersion, 2, 'record a current baseline with: node scripts/theme-config-smoke.cjs baseline');
      assert.deepEqual(baseline.themes, ['custom', 'mono', 'blue'], 'baseline must use the current theme set');
      assert.equal(today, baseline.date, 'run baseline and comparison on the same calendar date');
      const differences = [];
      assert.deepEqual(Object.keys(snapshots), Object.keys(baseline.snapshots), 'baseline must contain every sampled view');
      for (const [key, elements] of Object.entries(baseline.snapshots)) for (const [name, expected] of Object.entries(elements)) {
        const actual = snapshots[key]?.[name];
        if (!actual) { differences.push({ key, name, missing: true }); continue; }
        for (const [property, value] of Object.entries(expected.style)) if (actual.style[property] !== value) differences.push({ key, name, property, expected: value, actual: actual.style[property] });
        for (const [property, value] of Object.entries(expected.geometry)) if (Math.abs(actual.geometry[property] - value) > 1) differences.push({ key, name, property, expected: value, actual: actual.geometry[property] });
      }
      await fs.writeFile(path.join(output, 'theme-config-comparison.json'), JSON.stringify({ passed: !differences.length, differences, snapshots }, null, 2));
      assert.equal(differences.length, 0, `default rendering differs; see theme-config-comparison.json (${JSON.stringify(differences.slice(0, 3))})`);
      console.log('Three themes match the current recorded styles and geometry (1px tolerance).');
      await verifyCustomTheme();
    }
  } finally { if (app) await app.close(); await fs.rm(data, { recursive: true, force: true }); }

  async function verifyCustomTheme() {
    // Exercise the same configuration resolver and complete variable map used by applyAppearance.
    const source = stripTypeScriptTypes(await fs.readFile(path.join(root, 'src/renderer/theme.ts'), 'utf8'));
    const themes = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const standard = themes.themeConfig.themes.mono;
    const custom = structuredClone(standard);
    Object.assign(custom.palette, { text: '#3d2857', 'app-surface': '#ede3f7', surface: '#fdf7e7', mint: '#7351a6', 'modal-background': '#faf3e5' });
    custom.tokens = { fontSize: { md: '17px', sm: '16px' }, space: { 10: '14px', 12: '19px' }, radius: { panel: '21px' }, size: { action: '40px', actionSlot: '44px', modal: '520px', compactInput: '36px' }, iconSize: { default: '22px' }, opacity: { completed: '.5' }, mantineRadius: { md: '1.25rem' } };
    themes.themeConfig.themes.mono = custom;
    const variables = themes.themeVariables(themes.resolveTheme(custom)), preview = themes.previewVariables('mono');
    themes.themeConfig.themes.mono = standard;
    await settings(); await page.getByRole('button', { name: '黑白', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'mono');
    await page.evaluate(({ variables, preview }) => {
      for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
      for (const [name, value] of Object.entries(preview)) document.querySelector('[data-preview-theme="mono"]').style.setProperty(name, value);
    }, { variables, preview });
    await settle();
    const previewColor = await page.locator('[data-preview-theme="mono"]').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(previewColor, 'rgb(237, 227, 247)', 'preview follows the actual customized palette');
    await nav('Home').click(); await settle();
    const ordinary = await page.evaluate(() => {
      const row = document.querySelector('.task-row'), input = row.querySelector('.task-title input'), action = row.querySelector('button[aria-label^="编辑与改期"]');
      return { text: getComputedStyle(input).color, fontSize: getComputedStyle(input).fontSize, spacing: getComputedStyle(row).paddingTop, panelRadius: getComputedStyle(document.querySelector('.day-panel')).borderRadius, actionWidth: action.getBoundingClientRect().width, iconWidth: action.querySelector('svg').getBoundingClientRect().width, completedOpacity: getComputedStyle(document.querySelector('.task-row.completed')).opacity };
    });
    assert.deepEqual(ordinary, { text: 'rgb(61, 40, 87)', fontSize: '17px', spacing: '14px', panelRadius: '21px', actionWidth: 40, iconWidth: 22, completedOpacity: '0.5' });
    await page.getByRole('button', { name: '编辑与改期 主题配置验证待办', exact: true }).focus(); await page.keyboard.press('Enter');
    const modal = page.getByRole('dialog', { name: '编辑待办', exact: true }); await modal.waitFor(); await page.waitForTimeout(250);
    const portal = await modal.evaluate(el => ({ width: el.getBoundingClientRect().width, radius: getComputedStyle(el).borderRadius, color: getComputedStyle(el).backgroundColor, inputFont: getComputedStyle(el.querySelector('.modal-body input')).fontSize, inputHeight: el.querySelector('.modal-body input').getBoundingClientRect().height, footerPadding: getComputedStyle(el.querySelector('.modal-footer')).paddingTop }));
    assert.deepEqual(portal, { width: 520, radius: '21px', color: 'rgb(250, 243, 229)', inputFont: '16px', inputHeight: 36, footerPadding: '19px' });
    await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
    await nav('Home').hover(); await page.getByRole('tooltip', { name: 'Home', exact: true }).waitFor(); await page.waitForTimeout(250);
    const tooltip = await page.getByRole('tooltip', { name: 'Home', exact: true }).evaluate(el => ({ font: getComputedStyle(el).fontSize, radius: getComputedStyle(el).borderRadius, background: getComputedStyle(el).backgroundColor }));
    assert.equal(tooltip.font, '16px'); assert.equal(tooltip.background, 'rgb(61, 40, 87)');
    const rootFontSize = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    assert.equal(tooltip.radius, `${rootFontSize * parseFloat(custom.tokens.mantineRadius.md)}px`, 'Mantine provider radius resolves the customized rem token');
    await page.mouse.move(0, 0); await page.getByRole('tooltip', { name: 'Home', exact: true }).waitFor({ state: 'hidden' });
    for (const [id, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await settings(); await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
      const expected = themes.themeVariables(themes.getTheme(id));
      const actual = await page.evaluate(names => Object.fromEntries(names.map(name => [name, document.documentElement.style.getPropertyValue(name)])), Object.keys(expected));
      assert.deepEqual(actual, expected, id + ': complete default configuration replaces customized values');
    }
    await fs.writeFile(path.join(output, 'theme-config-customization.json'), JSON.stringify({ passed: true, customized: custom, previewColor, ordinary, portal, tooltip, restoresAllThemes: true }, null, 2));
    // Showing a hidden macOS window can adjust its bounds; screenshots follow all comparisons.
    await settings(); await page.getByRole('button', { name: '黑白', exact: true }).click(); await nav('Home').click();
    await screenshot('theme-config-mono.png');
    await page.evaluate(variables => { for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value); }, variables);
    await page.getByRole('button', { name: '编辑与改期 主题配置验证待办', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '编辑待办', exact: true }).waitFor();
    await screenshot('theme-config-custom-modal.png');
    console.log('Real configuration changes update CSS, Mantine, portal and preview; switching restores all defaults.');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
