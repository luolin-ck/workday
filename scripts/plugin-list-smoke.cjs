const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `plugin-list-${kind}`);
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-plugin-list-data-')));
  const packages = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-plugin-list-packages-')));
  const checks = [], frames = [], errors = [];
  const toggleSnapshots = [];
  let app, page;
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  await fs.rm(path.join(output, 'failure.json'), { force: true });
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: kind === 'source' ? [root] : [], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog, BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.hide(); window.webContents.setBackgroundThrottling(false);
      globalThis.__pluginList = { package: '', external: [], skillToggles: [] };
      dialog.showOpenDialog = async options => {
        if (options.properties?.includes('openDirectory') && globalThis.__pluginList.package)
          return { canceled: false, filePaths: [globalThis.__pluginList.package] };
        throw new Error('Unexpected native dialog in isolated plugin list fixture');
      };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'schedules.run',
          'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories',
          'git.import', 'projects.download', 'skills.approveRun'].includes(op)) {
          globalThis.__pluginList.external.push(op);
          throw new Error('External operations blocked in plugin list fixture');
        }
        const result = await original(event, op, input);
        if (op === 'skills.toggle') globalThis.__pluginList.skillToggles.push({
          op, ok: result.ok, enabled: result.value?.enabled ?? null, version: result.value?.version ?? null
        });
        return result;
      });
    });
    const call = async (op, input = {}) => {
      const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const waitSkillEnabled = async (id, enabled) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const responses = await app.evaluate(() => globalThis.__pluginList.skillToggles);
        const skill = (await call('state.get')).skills.find(skill => skill.id === id);
        toggleSnapshots.push({ expected: enabled, actual: skill.enabled, version: skill.version, responses });
        if (responses.length && responses.at(-1).enabled === enabled && skill.enabled === enabled) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Skill toggle did not settle: ' + JSON.stringify(toggleSnapshots.slice(-3)));
    };
    const frame = async name => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bytes = await page.screenshot({ animations: 'disabled' });
      assert.ok(bytes.length > 1000);
      await fs.writeFile(path.join(output, name), bytes);
      frames.push(name);
    };
    const longName = 'WorkDay fixture ' + 'W'.repeat(65) + ' ';
    const description = 'Synthetic description that is intentionally much longer than one row and must truncate without increasing the row height. '.repeat(6);
    const skills = [];
    for (let i = 1; i <= 4; i++) skills.push(await call('skills.save', {
      name: `${longName}${i}`, description, content: `Synthetic list fixture ${i}; do not execute anything.`
    }));
    const plugins = [];
    for (let i = 1; i <= 2; i++) {
      const directory = path.join(packages, `package-${i}`);
      await fs.mkdir(path.join(directory, 'skills/owned'), { recursive: true });
      await fs.writeFile(path.join(directory, 'workday-plugin.json'), JSON.stringify({
        id: `plugin-list-fixture-${i}`, name: `${longName}package ${i}`, version: '1.0.0', description,
        appVersion: '0.1', skills: ['skills/owned/SKILL.md'], mcp: ['mcp.json']
      }));
      await fs.writeFile(path.join(directory, 'skills/owned/SKILL.md'),
        `---\nname: owned-list-fixture-${i}\ndescription: Synthetic owned Skill; managed in its actual package.\n---\nSynthetic instructions only.\n`);
      await fs.writeFile(path.join(directory, 'mcp.json'), JSON.stringify({
        name: `owned-list-mcp-${i}`, transport: 'http', command: '', args: [], url: 'https://fixture.invalid/mcp'
      }));
      await app.evaluate((_, directory) => { globalThis.__pluginList.package = directory; }, directory);
      const preview = await call('plugins.preview');
      plugins.push(await call('plugins.install', { token: preview.token }));
    }
    const servers = [];
    for (let i = 1; i <= 2; i++) servers.push(await call('mcp.save', {
      name: `${longName}MCP ${i}`, transport: 'http', command: '', args: [],
      url: `https://fixture.invalid/${'synthetic-context-'.repeat(30)}mcp-${i}`
    }));
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '插件', exact: true }).click();
    const tab = name => page.getByRole('tab', { name, exact: true });
    const panel = () => page.getByRole('tabpanel');
    const row = name => panel().locator('.plugin-list-item').filter({ has: page.getByRole('button', { name: `查看 ${name}`, exact: true }) });
    const closeDialog = async () => {
      const dialog = page.getByRole('dialog').last();
      const label = await dialog.getAttribute('aria-labelledby');
      const exactDialog = page.locator(`[role="dialog"][aria-labelledby="${label}"]`);
      await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await exactDialog.waitFor({ state: 'hidden' });
    };
    const openMenu = async name => {
      const more = row(name).getByRole('button', { name: `更多操作 ${name}`, exact: true });
      await more.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor();
      return more;
    };
    // First assertion is deliberately the requested renderer contract, so the old card UI is a real Red.
    await tab('Skill').click();
    await panel().locator('.plugin-list').waitFor();
    for (const width of [1500, 660]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), width);
      await page.waitForFunction(width => innerWidth === width, width);
      for (const [name, fixtures] of [['Skill', skills], ['Plugin', plugins], ['MCP', servers]]) {
        await tab(name).click();
        const items = panel().locator('.plugin-list-item');
        assert.equal(await items.count(), fixtures.length, `${name}: owned components must not duplicate in independent lists`);
        const layout = await panel().locator('.plugin-list').evaluate(list => {
          const rows = [...list.querySelectorAll('.plugin-list-item')].map(item => {
            const title = item.querySelector('.plugin-item-title'), description = item.querySelector('.plugin-item-description');
            const main = item.querySelector('.plugin-item-main'), end = item.querySelector('.plugin-item-end');
            if (!title || !description || !main || !end) throw new Error('Incomplete shared plugin list item');
            const r = item.getBoundingClientRect(), m = main.getBoundingClientRect(), e = end.getBoundingClientRect();
            const text = element => ({ whiteSpace: getComputedStyle(element).whiteSpace,
              overflow: getComputedStyle(element).overflow, textOverflow: getComputedStyle(element).textOverflow,
              client: element.clientWidth, scroll: element.scrollWidth, right: element.getBoundingClientRect().right });
            return { height: r.height, top: r.top, left: r.left, right: r.right, mainRight: m.right,
              endLeft: e.left, endRight: e.right, endWidth: e.width, title: text(title), description: text(description) };
          });
          return { rows, columns: new Set(rows.map(r => Math.round(r.left))).size,
            overflow: document.documentElement.scrollWidth > innerWidth + 1 || list.closest('.page').scrollWidth > list.closest('.page').clientWidth + 1 };
        });
        assert.equal(layout.columns, width === 1500 ? 2 : 1, `${name}: responsive list columns`);
        assert.equal(layout.overflow, false, `${name}: page must not overflow horizontally`);
        for (const item of layout.rows) {
          assert.equal(item.height, 64, `${name}: fixed row height`);
          assert.equal(item.endWidth, 32, `${name}: one fixed action slot`);
          assert.ok(item.mainRight <= item.endLeft + 1 && item.endRight <= item.right + 1, `${name}: text cannot squeeze actions`);
          for (const text of [item.title, item.description]) {
            assert.equal(text.whiteSpace, 'nowrap'); assert.equal(text.overflow, 'hidden'); assert.equal(text.textOverflow, 'ellipsis');
            assert.ok(text.scroll > text.client, `${name}: synthetic long text really overflows`);
            assert.ok(text.right <= item.endLeft + 1, `${name}: title/description preserve action space`);
          }
        }
        await frame(`${name.toLowerCase()}-${width}.png`);
        checks.push({ kind: 'layout', tab: name, width, ...layout });
      }
    }
    await tab('Skill').click();
    const skillRow = row(skills[0].name), more = skillRow.getByRole('button', { name: `更多操作 ${skills[0].name}`, exact: true });
    const opacity = locator => locator.evaluate(element => {
      let result = 1;
      for (let e = element; e && !e.classList.contains('plugin-list-item'); e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.visibility === 'hidden' || style.display === 'none') return 0;
        result *= Number(style.opacity);
      }
      return result;
    });
    await page.mouse.move(0, 0); await tab('Skill').focus();
    assert.equal(await opacity(more), 0, 'More actions stay quiet until hover/focus');
    await skillRow.hover();
    await page.waitForFunction(name => {
      const button = [...document.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === `更多操作 ${name}`);
      return button && Number(getComputedStyle(button).opacity) > 0;
    }, skills[0].name);
    assert.ok(await opacity(more) > 0, 'Hover reveals more actions');
    await page.mouse.move(0, 0); await more.focus();
    assert.ok(await opacity(more) > 0, 'Keyboard focus reveals more actions');
    await openMenu(skills[0].name);
    const assertOpenSlot = async () => {
      await page.waitForFunction(name => {
        const button = [...document.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === `更多操作 ${name}`);
        const status = button?.closest('.plugin-list-item')?.querySelector('.plugin-item-status');
        return button && status && Number(getComputedStyle(button).opacity) === 1 && Number(getComputedStyle(status).opacity) === 0;
      }, skills[0].name);
      assert.equal(await opacity(more), 1, 'An open menu keeps its trigger visible');
      assert.equal(await opacity(skillRow.locator('.plugin-item-status')), 0, 'Open-menu actions replace the status in the same slot');
    };
    await page.getByRole('menuitem').first().focus();
    await assertOpenSlot();
    await page.getByRole('menuitem').first().hover();
    await assertOpenSlot();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await more.evaluate(e => document.activeElement === e), true, 'Escape returns focus to the menu trigger');
    await skillRow.getByRole('button', { name: `查看 ${skills[0].name}`, exact: true }).hover();
    const tooltip = page.getByRole('tooltip').filter({ hasText: skills[0].name });
    await tooltip.waitFor();
    const normalizedText = value => value.replace(/\s+/g, ' ').trim();
    const tooltipText = normalizedText(await tooltip.textContent());
    assert.ok(tooltipText.includes(normalizedText(skills[0].name)), 'Tooltip contains the complete title');
    assert.ok(tooltipText.includes(normalizedText(description)), 'Tooltip contains the complete description');
    await page.mouse.move(0, 0);
    await openMenu(skills[0].name); await page.getByRole('menuitem', { name: '停用', exact: true }).click();
    await waitSkillEnabled(skills[0].id, false);
    await openMenu(skills[0].name); await page.getByRole('menuitem', { name: '启用', exact: true }).click();
    await waitSkillEnabled(skills[0].id, true);
    const skillToggleResponses = await app.evaluate(() => globalThis.__pluginList.skillToggles);
    assert.deepEqual(skillToggleResponses.map(result => result.ok), [true, true], 'Both toggle IPC responses complete successfully');
    assert.deepEqual(skillToggleResponses.map(result => result.enabled), [false, true], 'Completed toggle responses match the requested states');
    assert.deepEqual(skillToggleResponses.map(result => result.version), [skills[0].version + 1, skills[0].version + 2], 'Each toggle persists exactly one new version');
    await openMenu(skills[0].name); await page.getByRole('menuitem', { name: '查看 / 编辑', exact: true }).click();
    await page.getByRole('heading', { name: '编辑 Skill', exact: true }).waitFor();
    await closeDialog();
    checks.push({ kind: 'interaction', passed: 'Skill hover/focus/tooltip/menu/Escape/toggle/view' });

    await tab('Plugin').click();
    await openMenu(plugins[0].name); await page.getByRole('menuitem', { name: '组件 · 2', exact: true }).click();
    await page.getByRole('heading', { name: `${plugins[0].name} · 组件`, exact: true }).waitFor();
    const components = page.getByRole('dialog').last();
    assert.ok((await components.innerText()).includes('owned-list-fixture-1'));
    assert.ok((await components.innerText()).includes('owned-list-mcp-1'));
    await components.getByRole('button', { name: '查看', exact: true }).click();
    await page.locator('.skill-detail').getByRole('heading', { name: 'owned-list-fixture-1', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator('.skill-detail').waitFor({ state: 'hidden' });
    await closeDialog();
    await openMenu(plugins[0].name); await page.getByRole('menuitem', { name: '卸载', exact: true }).click();
    await page.getByRole('heading', { name: '卸载 Plugin', exact: true }).waitFor();
    await page.getByRole('dialog').last().getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal((await call('state.get')).plugins.length, 2, 'Cancel uninstall preserves the package');
    checks.push({ kind: 'interaction', passed: 'Plugin component/view/menu/uninstall confirmation cancel' });

    await tab('MCP').click();
    await row(servers[0].name).getByRole('button', { name: `查看 ${servers[0].name}`, exact: true }).click();
    const detail = panel().locator('.source-detail');
    const detailHeading = detail.getByRole('heading', { name: servers[0].name, exact: true });
    await detailHeading.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'MCP opens its existing detail view without another modal');
    await detail.getByRole('button', { name: '编辑配置', exact: true }).click();
    await page.getByRole('heading', { name: '编辑 MCP 连接', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await detailHeading.waitFor();
    await panel().getByRole('button', { name: '返回 MCP 列表', exact: true }).waitFor();
    await detail.getByRole('button', { name: '预览并启用', exact: true }).click();
    await page.getByRole('heading', { name: '预览并启用 MCP 连接', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await detailHeading.waitFor();
    await panel().getByRole('button', { name: '返回 MCP 列表', exact: true }).click();
    await panel().getByRole('list', { name: 'MCP 列表', exact: true }).waitFor();
    assert.equal(await panel().locator('.plugin-list-item').count(), 2);
    assert.equal(await detail.count(), 0, 'Returning restores the list without keeping an active detail panel');
    const state = await call('state.get');
    assert.equal(state.mcpServers.every(m => !m.enabled && !m.discoveredAt), true, 'Opening details/enable preview never connects MCP');
    assert.equal(state.skills.length, 6); assert.equal(state.plugins.length, 2); assert.equal(state.mcpServers.length, 4);
    assert.deepEqual(await app.evaluate(() => globalThis.__pluginList.external), []);
    assert.deepEqual(errors, []);
    const runtime = await app.evaluate(({ app }) => ({ executable: process.execPath, data: app.getPath('userData') }));
    assert.equal(await fs.realpath(runtime.data), data);
    checks.push({ kind: 'interaction', passed: 'MCP list/detail navigation, editor and enable-preview Escape preserve details without connecting' });
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      passed: true, kind, checks, frames, runtime, skillToggleResponses, personalData: false, realModel: false, externalRequests: 0
    }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    const skillToggleResponses = app ? await app.evaluate(() => globalThis.__pluginList?.skillToggles).catch(() => null) : null;
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, frames, skillToggleResponses, toggleSnapshots }, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(data, { recursive: true, force: true });
    await fs.rm(packages, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
