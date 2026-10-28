const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `skill-detail-${kind}`);
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-skill-detail-data-')));
  const packages = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-skill-detail-packages-')));
  const checks = [], frames = [], errors = [], rendererRequests = [];
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
    await page.route(/^https?:\/\//, route => { rendererRequests.push(route.request().url()); return route.abort(); });
    await app.evaluate(({ dialog, BrowserWindow, ipcMain, shell }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.hide(); window.webContents.setBackgroundThrottling(false);
      // Exercise the modal's constrained-height layout below the app's normal 620 px window minimum.
      window.setMinimumSize(0, 0);
      globalThis.__skillDetail = { selected: '', operations: [], external: [], externalLinks: [] };
      dialog.showOpenDialog = async () => {
        if (globalThis.__skillDetail.selected) return { canceled: false, filePaths: [globalThis.__skillDetail.selected] };
        throw new Error('Unexpected native dialog in isolated Skill detail fixture');
      };
      shell.openExternal = async url => { globalThis.__skillDetail.externalLinks.push(url); };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'schedules.run',
          'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories',
          'git.import', 'projects.download', 'skills.approveRun'].includes(op)) {
          globalThis.__skillDetail.external.push(op);
          throw new Error('External operations blocked in Skill detail fixture');
        }
        const result = await original(event, op, input);
        if (['skills.toggle', 'conversations.create', 'conversations.context'].includes(op))
          globalThis.__skillDetail.operations.push({ op, ok: result.ok, value: result.ok ? result.value : null });
        return result;
      });
    });
    const call = async (op, input = {}) => {
      const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const settle = async (predicate, description) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = await call('state.get');
        if (predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error(`State did not settle: ${description}`);
    };
    const frame = async name => {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await page.mouse.move(1, 1);
      if (await page.locator('.skill-detail-reader').count()) await page.locator('.skill-detail-reader').focus();
      await page.getByRole('tooltip').first().waitFor({ state: 'hidden' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bytes = await page.screenshot({ animations: 'disabled' });
      assert.ok(bytes.length > 1000);
      await fs.writeFile(path.join(output, name), bytes); frames.push(name);
    };
    const markdown = [
      '# Synthetic workflow', '', 'A **rendered strong phrase** and *emphasized phrase* with `inline-code`.', '',
      '## Required deliverables', '', '1. First ordered item', '2. Second ordered item', '   - Nested unordered item', '',
      '- First bullet', '- Second bullet', '', '```javascript', 'const example = "SAFE_CODE_TEXT";', '```', '',
      '| Column A | Column B |', '| --- | --- |', '| first | second |', '',
      '<script>window.__skillDetailInjected = true</script>',
      '<img src="https://skill-detail.invalid/raw.png" onerror="window.__skillDetailInjected = true">',
      '[Dangerous link](javascript:window.__skillDetailInjected=true)',
      '![Remote fixture image](https://skill-detail.invalid/remote.png)', '',
      ...Array.from({ length: 28 }, (_, index) => `### Step ${index + 1}\n\nSynthetic detail paragraph ${index + 1}. ${'Read-only descriptive instructions. '.repeat(8)}`)
    ].join('\n');
    const plain = await call('skills.save', {
      name: 'Synthetic readable Skill', description: 'Synthetic workflow description shown as readable text.', content: markdown
    });
    const goPlugins = async () => {
      await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '插件', exact: true }).click();
    };
    const tab = name => page.getByRole('tab', { name, exact: true });
    const detail = () => page.locator('.skill-detail');
    const closeDetail = async () => {
      await detail().getByRole('button', { name: '关闭详情', exact: true }).click();
      await detail().waitFor({ state: 'hidden' });
    };
    const openSkill = async name => {
      await goPlugins(); await tab('Skill').click();
      await page.getByRole('tabpanel').getByRole('button', { name: `查看 ${name}`, exact: true }).click();
    };
    const openDetailMenu = async () => {
      await detail().getByRole('button', { name: 'Skill 更多操作', exact: true }).click();
      await page.getByRole('menu').waitFor();
    };
    await openSkill(plain.name);
    // Deliberately before supplementary fixtures: the previous edit form lacks this requested detail UI.
    assert.equal(await detail().count(), 1, 'Skill click must open the compact readable detail, not an edit form');
    await page.getByRole('dialog', { name: plain.name, exact: true }).waitFor();
    assert.equal(await detail().locator('.skill-markdown').count(), 1, 'Skill instructions render as Markdown by default');
    assert.equal(await detail().locator('textarea').count(), 0, 'Read-only details contain no form textareas');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Exactly one detail dialog is visible');
    for (const selector of ['h1', 'h2', 'strong', 'em', 'ol', 'ul', 'li', 'pre code', 'table'])
      assert.ok(await detail().locator(`.skill-markdown ${selector}`).count() > 0, `Rendered Markdown contains ${selector}`);
    assert.ok((await detail().locator('.skill-markdown').innerText()).includes('SAFE_CODE_TEXT'));
    assert.equal(await detail().locator('.skill-markdown script, .skill-markdown img, .skill-markdown iframe').count(), 0,
      'Untrusted markup and images do not create executable or network elements');
    assert.equal(await detail().locator('.skill-markdown a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__skillDetailInjected), undefined);
    assert.deepEqual(rendererRequests, [], 'Displaying a Skill must not fetch its remote Markdown images');
    checks.push({ kind: 'rendering', passed: 'Default detail, semantic Markdown, unsafe HTML/link/image suppression' });
    if (process.env.WORKDAY_SMOKE_RED_ONLY === '1') return;

    for (const [width, height] of [[1400, 800], [660, 700], [660, 440]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height]);
      await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height]);
      const geometry = await detail().evaluate(root => {
        const reader = root.querySelector('.skill-detail-reader');
        const footerButton = [...root.querySelectorAll('button')].find(button => button.textContent.includes('立即试用'));
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
        return { viewport: { width: innerWidth, height: innerHeight }, root: rect(root), reader: rect(reader), footer: rect(footerButton),
          readerOverflowY: getComputedStyle(reader).overflowY, readerClient: reader.clientHeight, readerScroll: reader.scrollHeight,
          rootClient: root.clientHeight, rootScroll: root.scrollHeight, rootClientWidth: root.clientWidth, rootScrollWidth: root.scrollWidth };
      });
      assert.ok(geometry.root.x >= -1 && geometry.root.y >= -1 && geometry.root.right <= width + 1 && geometry.root.bottom <= height + 1, 'Details fit viewport');
      assert.ok(geometry.footer.bottom <= height && geometry.footer.y >= 0, 'Try button remains visible');
      assert.ok(geometry.readerScroll > geometry.readerClient, 'Long body really overflows');
      assert.ok(['auto', 'scroll'].includes(geometry.readerOverflowY), 'Only the reader scrolls long instructions');
      assert.ok(geometry.rootScroll <= geometry.rootClient + 1, 'The outer detail content does not scroll');
      assert.ok(geometry.rootScrollWidth <= geometry.rootClientWidth + 1, 'Details do not overflow horizontally');
      await detail().locator('.skill-detail-reader').evaluate(reader => { reader.scrollTop = reader.scrollHeight; });
      const scrolled = await detail().locator('.skill-detail-reader').evaluate(reader => reader.scrollTop);
      assert.ok(scrolled > 0, 'Reader can be scrolled independently');
      await detail().locator('.skill-detail-reader').evaluate(reader => { reader.scrollTop = 0; });
      await frame(`detail-${width}x${height}.png`);
      checks.push({ kind: 'layout', width, height, geometry });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 800));
    await page.waitForFunction(() => innerWidth === 1400 && innerHeight === 800);
    await openDetailMenu(); await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await detail().count(), 1, 'Menu Escape preserves the detail dialog');
    await openDetailMenu(); await page.getByRole('menuitem', { name: '查看原文', exact: true }).click();
    const raw = detail().locator('.skill-detail-reader pre.skill-source');
    assert.equal(await raw.count(), 1);
    assert.equal(await raw.textContent(), markdown, 'Raw view preserves complete instructions verbatim');
    await openDetailMenu(); await page.getByRole('menuitem', { name: '查看说明', exact: true }).click();
    await detail().locator('.skill-markdown h1').waitFor();
    checks.push({ kind: 'view', passed: 'Menu Escape preserves details; full raw and Markdown views toggle' });

    const toggle = detail().getByLabel('启用 Skill', { exact: true });
    assert.equal(await toggle.isChecked(), true);
    await detail().locator('.mantine-Switch-track').click(); await settle(state => state.skills.find(skill => skill.id === plain.id)?.enabled === false, 'disable Skill');
    await page.waitForFunction(() => { const input = document.querySelector('.skill-detail input[role="switch"]'); return input && !input.disabled && !input.checked; });
    assert.equal(await detail().getByRole('button', { name: '立即试用', exact: true }).isEnabled(), false);
    await toggle.focus(); await toggle.press('Space'); await settle(state => state.skills.find(skill => skill.id === plain.id)?.enabled === true, 'enable Skill');
    await openDetailMenu(); await page.getByRole('menuitem', { name: '编辑 Skill', exact: true }).click();
    await page.getByRole('heading', { name: '编辑 Skill', exact: true }).waitFor();
    assert.equal(await detail().count(), 0, 'Opening editor unmounts the detail dialog');
    assert.equal(await page.getByRole('dialog').count(), 1, 'Editor has no underlying detail dialog');
    await page.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click();
    await detail().waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Closing editor restores exactly one detail dialog');
    await closeDetail();
    checks.push({ kind: 'edit', passed: 'Toggle persists; disabled Skill cannot try; editor replaces details and returns' });

    const directory = path.join(packages, 'real-package');
    await fs.mkdir(path.join(directory, 'skills/owned'), { recursive: true });
    await fs.writeFile(path.join(directory, 'workday-plugin.json'), JSON.stringify({
      id: 'skill-detail-fixture', name: 'Synthetic detail package', version: '1.0.0',
      description: 'A genuine package fixture for owned Skill navigation.', appVersion: '0.1', skills: ['skills/owned/SKILL.md'], mcp: []
    }));
    await fs.writeFile(path.join(directory, 'skills/owned/SKILL.md'), `---\nname: owned-detail-fixture\ndescription: Owned detail navigation fixture.\n---\n${markdown}`);
    await app.evaluate((_, directory) => { globalThis.__skillDetail.selected = directory; }, directory);
    const preview = await call('plugins.preview');
    const plugin = await call('plugins.install', { token: preview.token });
    const owned = (await call('state.get')).skills.find(skill => skill.ownerPluginId === plugin.id);
    const openOwned = async () => {
      await goPlugins(); await tab('Plugin').click();
      await page.getByRole('tabpanel').getByRole('button', { name: `查看 ${plugin.name}`, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '查看', exact: true }).click();
      await detail().waitFor();
    };
    await openOwned();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Owned detail replaces components modal');
    await closeDetail();
    await page.getByRole('heading', { name: `${plugin.name} · 组件`, exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Closing owned detail returns to exactly one components modal');
    await page.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const disabledPlugin = await call('plugins.toggle', { id: plugin.id, expectedVersion: plugin.version, enabled: false });
    await openOwned();
    assert.equal(await detail().getByRole('button', { name: '立即试用', exact: true }).isEnabled(), false, 'Disabled owner blocks try');
    assert.equal(await detail().getByLabel('启用 Skill', { exact: true }).isEnabled(), false, 'Disabled owner blocks component toggle');
    await closeDetail();
    await page.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const enabledPlugin = await call('plugins.toggle', { id: plugin.id, expectedVersion: disabledPlugin.version, enabled: true });
    checks.push({ kind: 'ownership', passed: 'Owned details replace/restore components; disabled owner blocks use and toggle' });

    const trySkill = async (skill, parent) => {
      const before = await call('state.get');
      if (parent) await openOwned(); else await openSkill(skill.name);
      await detail().getByRole('button', { name: '立即试用', exact: true }).click();
      await detail().waitFor({ state: 'hidden' });
      const after = await settle(state => state.conversations.length === before.conversations.length + 1
        && state.conversations.some(chat => !before.conversations.some(previous => previous.id === chat.id)
          && chat.context.skillRef?.id === skill.id), 'Skill context conversation');
      const created = after.conversations.find(chat => !before.conversations.some(previous => previous.id === chat.id));
      const currentSkill = after.skills.find(item => item.id === skill.id);
      assert.deepEqual(created.context.skillRef, { id: skill.id, version: currentSkill.version });
      assert.deepEqual(created.context.mcpRefs, [], 'Trying a Skill grants no MCP capability');
      if (parent) assert.deepEqual(created.context.pluginRefs, [{ id: parent.id, version: enabledPlugin.version, skillId: skill.id, mcpRefs: [] }]);
      else assert.ok(!created.context.pluginRefs?.length);
      assert.deepEqual(await call('conversations.history', { id: created.id }), [], 'Try creates an empty chat without sending instructions');
      await page.getByRole('textbox', { name: '消息输入', exact: true }).waitFor();
      const chip = page.locator('.context-chips[aria-label="已选上下文"]');
      await chip.waitFor();
      assert.ok((await chip.innerText()).includes(parent ? parent.name : skill.name));
      assert.equal(await page.getByRole('dialog').count(), 0, 'Try leaves no component/detail dialog over chat');
      return { conversationId: created.id, skillId: skill.id, owned: !!parent };
    };
    const tries = [await trySkill(plain), await trySkill(owned, plugin)];
    await frame('skill-try-context.png');
    checks.push({ kind: 'try', passed: 'Independent and owned Skill create empty chats with exact refs; never send', tries });
    const capture = await app.evaluate(() => globalThis.__skillDetail);
    assert.deepEqual(capture.external, []);
    assert.deepEqual(capture.externalLinks, []);
    assert.deepEqual(rendererRequests, []);
    assert.deepEqual(errors, []);
    assert.ok(capture.operations.every(operation => operation.ok));
    const runtime = await app.evaluate(({ app }) => ({ executable: process.execPath, data: app.getPath('userData') }));
    assert.equal(await fs.realpath(runtime.data), data);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({
      passed: true, kind, checks, frames, runtime, operations: capture.operations.map(({ op, ok }) => ({ op, ok })),
      personalData: false, realModel: false, externalRequests: 0, renderedNetworkRequests: rendererRequests
    }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, frames, rendererRequests }, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(data, { recursive: true, force: true });
    await fs.rm(packages, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
