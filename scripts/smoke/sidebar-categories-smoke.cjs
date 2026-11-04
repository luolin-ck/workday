// Isolated Electron acceptance for projectless chats as a peer sidebar category.
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
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/sidebar-categories-' + kind));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-sidebar-categories-')));
  const startedAt = new Date().toISOString(), checks = [], frames = [], layouts = [], errors = [];
  let app, page;
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const until = async (test, label) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error('Timed out: ' + label);
  };
  const call = async (op, input = {}) => {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const frame = async name => {
    await page.mouse.move(0, 0);
    const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64')); frames.push(name);
  };
  const sidebar = () => page.getByRole('region', { name: '项目与聊天', exact: true });
  const projectless = () => sidebar().getByRole('region', { name: '不在项目中', exact: true });
  const projects = () => sidebar().getByRole('region', { name: '项目', exact: true });
  const openChat = title => sidebar().getByRole('button', { name: title, exact: true });
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
      globalThis.__categoriesFixture = { blocked: [] };
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        if (['chat.send', 'chat.retry', 'sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save'].includes(op)) {
          globalThis.__categoriesFixture.blocked.push(op); throw Error('External operation blocked');
        }
        return original(event, op, input);
      });
    }, data);
    await page.route(/^https?:\/\//, route => { errors.push('Unexpected renderer network'); return route.abort(); });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const folder = path.join(data, 'fixture-project'); await fs.mkdir(folder);
    const project = await call('projects.save', { name: '分类验收项目', description: '', directory: folder });
    const free = await call('conversations.create', { title: '未归属项目的聊天：较长标题仍保持省略和操作按钮对齐', projectId: null, date: null, model: null });
    const owned = await call('conversations.create', { title: '项目内聊天', projectId: project.id, date: null, model: null });
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    assert.equal(await projectless().count(), 1, 'BUSINESS RED: projectless chats require their own category outside the Projects category');
    assert.equal(await projects().count(), 1, 'Projects requires its own labelled category');
    const hierarchy = await sidebar().evaluate(element => {
      const free = element.querySelector('section[aria-label="不在项目中"]'), projects = element.querySelector('section[aria-label="项目"]');
      return { peers: free.parentElement === projects.parentElement, projectsFirst: !!(projects.compareDocumentPosition(free) & Node.DOCUMENT_POSITION_FOLLOWING), freeGroups: free.querySelectorAll('.project-group').length, projectsGroups: projects.querySelectorAll('.project-group').length, nestedFree: projects.contains(free), freeIcons: free.querySelector('h2').querySelectorAll('svg').length };
    });
    assert.deepEqual(hierarchy, { peers: true, projectsFirst: true, freeGroups: 0, projectsGroups: 1, nestedFree: false, freeIcons: 0 });
    assert.equal(await projectless().getByRole('button', { name: '不在项目中', exact: true }).count(), 0, 'Projectless heading has no disclosure control');
    assert.equal(await projectless().getByRole('button', { name: '创建项目', exact: true }).count(), 0);
    assert.equal(await projects().getByRole('button', { name: '创建项目', exact: true }).count(), 1);
    assert.equal(await projectless().locator('.project-select').count(), 0, 'Projectless category must not be rendered as a project row');
    await projectless().getByRole('heading', { name: '不在项目中', level: 2, exact: true }).waitFor();
    await projects().getByRole('heading', { name: '项目', level: 2, exact: true }).waitFor();
    checks.push('Projectless chats follow Projects as a peer category with a static heading; only actual projects appear under Projects');

    // Regression for opening ProjectEditor without an existing Project value.
    const newFolder = path.join(data, 'new-project'); await fs.mkdir(newFolder);
    await app.evaluate(({ dialog }, selected) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (...args) => {
        dialog.showOpenDialog = original;
        globalThis.__categoriesDialogOptions = args.at(-1);
        return { canceled: false, filePaths: [selected] };
      };
    }, newFolder);
    await projects().getByRole('button', { name: '创建项目', exact: true }).click();
    await page.getByRole('menuitem', { name: '本地文件夹', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '创建项目', exact: true }); await editor.waitFor();
    assert.deepEqual((await app.evaluate(() => globalThis.__categoriesDialogOptions)).properties, ['openDirectory']);
    assert.equal(await editor.getByLabel('项目名称', { exact: true }).inputValue(), 'new-project');
    assert.equal(await editor.getByRole('textbox', { name: /^项目文件夹/ }).inputValue(), await fs.realpath(newFolder));
    await editor.getByRole('button', { name: '取消', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    assert.equal((await call('state.get')).projects.length, 1, 'Cancelling creation leaves existing projects unchanged');
    checks.push('Create project opens the local-folder editor without an existing Project; cancelling creates nothing');

    const verifyLayout = async () => {
      const layout = await sidebar().evaluate(element => {
        const sections = [...element.querySelectorAll('section[aria-label="不在项目中"],section[aria-label="项目"]')];
        const headings = sections.map(section => { const h = section.querySelector('h2'), r = h.getBoundingClientRect(), s = getComputedStyle(h); return { left: r.left, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color }; });
        const actions = [...element.querySelectorAll('.conversation-row>.project-more,.project-group-heading>.project-more,[aria-label="创建项目"]')].map(button => { const r = button.getBoundingClientRect(); return r.width ? r.x + r.width / 2 : null; }).filter(value => value !== null);
        const title = element.querySelector('.conversation-open span'), titleStyle = getComputedStyle(title);
        return { headings, actions, titleFontSize: titleStyle.fontSize, titleColor: titleStyle.color, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(Math.abs(layout.headings[0].left - layout.headings[1].left) < 0.5, 'Category headings share their left edge');
      assert.equal(layout.headings[0].fontSize, layout.headings[1].fontSize);
      assert.equal(layout.headings[0].fontWeight, layout.headings[1].fontWeight);
      assert.equal(layout.headings[0].color, layout.headings[1].color);
      assert.ok(parseFloat(layout.headings[0].fontSize) < parseFloat(layout.titleFontSize), 'Category headings are visually quieter than chat titles');
      assert.notEqual(layout.headings[0].color, layout.titleColor, 'Category headings use muted text');
      assert.ok(Math.max(...layout.actions) - Math.min(...layout.actions) < 0.5, 'Project and chat actions share the right-hand axis across categories');
      assert.equal(layout.overflow, false);
      layouts.push(layout);
    };
    await verifyLayout(); await frame('sidebar-categories.png');
    checks.push('Peer headings align and use matching quiet typography; chat and project actions remain aligned');

    await openChat(free.title).click();
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('项目折叠保留未发送草稿');
    const projectToggle = projects().getByRole('button', { name: project.name, exact: true });
    await projectToggle.click(); await openChat(owned.title).waitFor({ state: 'hidden' });
    await openChat(free.title).waitFor(); assert.equal(await projectToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await openChat(free.title).getAttribute('aria-current'), 'page');
    assert.equal(await input.inputValue(), '项目折叠保留未发送草稿');
    await projectToggle.press('Enter'); await openChat(owned.title).waitFor();
    await projectToggle.press('Space'); await openChat(owned.title).waitFor({ state: 'hidden' });
    await openChat(free.title).waitFor();
    await projectToggle.press('Space'); await openChat(owned.title).waitFor();
    checks.push('Actual projects fold with mouse and keyboard while projectless chats stay visible and preserve the active draft');

    await openChat(owned.title).click(); await input.fill('项目内草稿');
    await projectToggle.click(); await openChat(owned.title).waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), '项目内草稿');
    await projectToggle.click(); await openChat(owned.title).waitFor();
    assert.equal(await openChat(owned.title).getAttribute('aria-current'), 'page');
    await openChat(free.title).click();
    await until(async () => await input.inputValue() === '项目折叠保留未发送草稿', 'projectless draft is restored');
    for (const [region, title] of [[projectless(), free.title], [projects(), owned.title]]) {
      await region.getByRole('button', { name: '聊天操作 ' + title, exact: true }).click();
      await page.getByRole('menuitem', { name: '改名', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: '移动', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: '归档', exact: true }).waitFor();
      assert.equal(await input.inputValue(), '项目折叠保留未发送草稿');
      await page.keyboard.press('Escape');
    }
    checks.push('Chat selection restores drafts and both categories retain rename, move and archive menus without navigating');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 900));
    await until(() => page.evaluate(() => innerWidth === 760), 'narrow width');
    await verifyLayout(); await frame('sidebar-categories-narrow.png');
    checks.push('The category hierarchy and action alignment remain usable at a narrow viewport');
    const isolation = await app.evaluate(() => ({ blocked: globalThis.__categoriesFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls }));
    assert.deepEqual(isolation.blocked, []); assert.equal(isolation.nativeCalls, 0); assert.equal(isolation.credentialCalls, 0); assert.deepEqual(errors, []);
    const runtime = await app.evaluate(({ app }, expected) => ({ app: app.getAppPath(), executable: app.getPath('exe'), dataDirectoryVerified: app.getPath('userData') === expected }), data);
    assert.ok(runtime.dataDirectoryVerified);
    const result = { passed: true, kind, startedAt, completedAt: new Date().toISOString(), runtime, checks, frames, layouts, isolation, errors, personalData: false, realModel: false, realCredentials: false, scriptSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex') };
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
