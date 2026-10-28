const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const label = { skill: 'Skill', mcp: 'MCP', plugin: 'Plugin' };
const title = (kind, intent) => `${intent === 'import' ? '导入' : kind === 'mcp' ? '添加' : '创建'} ${label[kind]}`;
const skillText = name => `---\nname: ${name}\ndescription: Summarize a supplied synthetic document when requested.\n---\n# Summary\nRead the supplied document, then write a concise summary.\n`;

async function main() {
  const root = path.resolve(__dirname, '..');
  const mode = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `internal-capabilities-compat-${mode}`);
  const results = path.join(root, 'test-results', `internal-capabilities-compat-${mode}-smoke.json`);
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-component-chat-')));
  const data = path.join(temp, 'data');
  const materialRoot = path.join(temp, 'materials');
  const checks = [], frames = [], errors = [], bodies = [], wireCalls = [], fixtureErrors = [];
  const plans = new Map();
  let app, page;
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(materialRoot, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(path.dirname(results), { recursive: true });
  await fs.rm(results, { force: true });
  await fs.rm(path.join(output, 'failure.json'), { force: true });

  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions', 'Only synthetic model completions are permitted');
      let raw = '';
      for await (const part of req) { raw += part; assert.ok(raw.length < 2_000_000); }
      const body = JSON.parse(raw);
      bodies.push(body);
      const text = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content);
      const entry = [...plans].find(([marker]) => text.includes(marker));
      assert.ok(entry, 'No synthetic scenario matches the user message');
      const [marker, plan] = entry;
      const tools = body.tools.map(tool => tool.function.name);
      assert.deepEqual(tools.sort(), ['workday_component_propose', 'workday_component_read']);
      const toolMessages = body.messages.filter(message => message.role === 'tool');
      const readResult = toolMessages.map(message => {
        try { return JSON.parse(message.content); } catch { return null; }
      }).find(value => value?.materials?.length);
      const token = readResult?.materials[0]?.token;
      let action;
      if (toolMessages.length === 0) action = { name: 'workday_component_read', arguments: { source: 'builtin', path: 'references/format.md' } };
      else if (plan.intent === 'import' && toolMessages.length === 1) action = { name: 'workday_component_read', arguments: { source: 'materials', path: '.' } };
      else if (plan.intent === 'import' && toolMessages.length === 2) {
        assert.ok(token, 'Selected material token reached the model through the read tool');
        action = { name: 'workday_component_read', arguments: { source: 'materials', token, path: plan.readPath } };
      } else if (toolMessages.length === (plan.intent === 'import' ? 3 : 1)) {
        action = { name: 'workday_component_propose', arguments: plan.intent === 'import' ? { materialToken: token } : plan.proposal };
      }
      const delta = action ? { tool_calls: [{ index: 0, id: `component-call-${bodies.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { content: '已准备安装提案，请检查文件和组件后确认安装。' };
      if (action) wireCalls.push({ marker, name: action.name });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: action ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      fixtureErrors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end('Synthetic component fixture failed');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const modelBase = `http://127.0.0.1:${server.address().port}/v1`;

  async function writeTree(directory, files) {
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(directory, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, value.bytes ?? value);
      if (value.mode) await fs.chmod(file, value.mode);
    }
  }
  const longReference = '这是可分页读取的合成资料。 Unicode 😀\n'.repeat(1000) + 'END_OF_COMPLETE_REFERENCE';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const skillFiles = {
    'SKILL.md': skillText('imported-component-fixture'),
    'references/long.md': longReference,
    'scripts/no-run.sh': { bytes: '#!/bin/sh\nexit 73\n', mode: 0o755 },
    'assets/pixel.png': png,
  };
  for (let index = 0; index < 35; index++) skillFiles[`references/part-${index}.md`] = `Synthetic resource ${index}`;
  const skillDirectory = path.join(materialRoot, 'skill-fixture');
  await writeTree(skillDirectory, skillFiles);
  const manifest = (id, name) => JSON.stringify({ id, name, version: '1.0.0', description: 'Synthetic component package', appVersion: '0.1', skills: ['skills/summary/SKILL.md'], mcp: ['mcp.json'] });
  const pluginDirectory = path.join(materialRoot, 'plugin-fixture');
  const pluginFiles = {
    'workday-plugin.json': manifest('imported-component-plugin', 'Imported component plugin'),
    'skills/summary/SKILL.md': skillText('imported-package-summary'),
    'skills/summary/references/example.md': 'Complete package resource',
    'assets/pixel.png': png,
    'mcp.json': JSON.stringify({ name: 'Imported package MCP', transport: 'http', command: '', args: [], url: 'https://fixture.invalid/mcp' }),
  };
  await writeTree(pluginDirectory, pluginFiles);
  const mcpFile = path.join(materialRoot, 'servers.json');
  await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: {
    'Imported HTTP MCP': { type: 'streamable-http', url: 'https://fixture.invalid/imported' },
    'Imported stdio MCP': { command: '/synthetic/not-executed-mcp', args: ['--read-only'] },
  } }));
  const attachment = path.join(materialRoot, 'reference.txt');
  await fs.writeFile(attachment, 'SYNTHETIC_ATTACHMENT_REMAINS_AVAILABLE');

  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: mode === 'source' ? [root] : [], env, timeout: 30000,
    }, { mockHolidays: true, keychain: true });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog, BrowserWindow, ipcMain }) => {
      globalThis.__componentSmoke = { material: null, attachments: [], dialogs: [], denied: [], operations: [] };
      dialog.showOpenDialog = async options => {
        globalThis.__componentSmoke.dialogs.push(options.title);
        if (options.title === '添加聊天附件') return { canceled: false, filePaths: globalThis.__componentSmoke.attachments };
        if (['选择 Skill 目录或 SKILL.md', '选择 MCP JSON', '选择 Plugin 目录'].includes(options.title)) {
          const file = globalThis.__componentSmoke.material;
          return { canceled: !file, filePaths: file ? [file] : [] };
        }
        throw Error('Unexpected dialog in component fixture: ' + options.title);
      };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        globalThis.__componentSmoke.operations.push(op);
        if (['sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun'].includes(op)) {
          globalThis.__componentSmoke.denied.push(op);
          throw Error('External operation is forbidden in isolated component fixture');
        }
        return original(event, op, input);
      });
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.showInactive();
    });
    const call = async (op, input = {}) => {
      const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const until = async (predicate, description) => {
      for (let index = 0; index < 300; index++) { const value = await predicate(); if (value) return value; await sleep(40); }
      throw Error('Timed out: ' + description);
    };
    const resize = async width => {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(width, 1000);
        window.show();
        window.focus();
      }, width);
      await page.waitForFunction(width => innerWidth === width, width);
    };
    const frame = async name => {
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.showInactive();
        return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
      });
      assert.ok(bytes.length > 1000);
      await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64'));
      frames.push(name);
    };
    const entries = [];
    async function enter(kind, intent) {
      const before = await call('state.get');
      const ids = new Set(before.conversations.map(conversation => conversation.id));
      const requestsBefore = bodies.length;
      await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '插件', exact: true }).click();
      await page.getByRole('tab', { name: label[kind], exact: true }).click();
      if (intent === 'import') {
        await page.getByRole('button', { name: label[kind] + ' 更多操作', exact: true }).click();
        await page.getByRole('menuitem', { name: title(kind, intent), exact: true }).click();
      } else await page.getByRole('tabpanel').getByRole('button', { name: '新增 ' + label[kind], exact: true }).click();
      await page.getByLabel('消息输入', { exact: true }).waitFor();
      await page.getByRole('button', { name: '结束管理', exact: true }).waitFor();
      await page.getByRole('button', { name: '选择本地材料', exact: true }).waitFor();
      const state = await call('state.get');
      const created = state.conversations.filter(conversation => !ids.has(conversation.id));
      assert.equal(created.length, 1);
      const conversation = created[0];
      assert.equal(conversation.title, title(kind, intent));
      assert.equal(conversation.projectId, null);
      assert.equal((await call('conversations.history', { id: conversation.id })).length, 0);
      assert.ok((await page.getByLabel('消息输入', { exact: true }).inputValue()).includes(intent === 'import' ? '导入' : kind === 'mcp' ? '添加' : '创建'));
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(bodies.length, requestsBefore, 'Entry does not send the seed prompt');
      const session = await call('components.session', { conversationId: conversation.id });
      assert.equal(session.active, true);
      assert.equal(session.kind, kind);
      assert.equal(session.intent, intent);
      entries.push({ kind, intent, id: conversation.id });
      return conversation;
    }
    async function sendProposal(conversation, plan, marker) {
      plans.set(marker, plan);
      await page.getByLabel('消息输入', { exact: true }).fill(marker + ' 请生成供我审阅的安装提案。');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await until(async () => {
        const history = await call('conversations.history', { id: conversation.id });
        const reply = history.filter(message => message.role === 'assistant').at(-1);
        if (!reply || reply.status === 'running') return false;
        assert.equal(reply.status, 'complete', reply.error);
        return reply;
      }, marker + ' completed model reply');
      const draft = (await call('state.get')).drafts.find(draft => draft.kind === 'component' && draft.conversationId === conversation.id);
      assert.ok(draft, 'Model tool creates a persistent component draft');
      assert.equal(draft.status, 'pending');
      const preview = page.getByRole('region', { name: `${label[plan.kind]} 安装提案`, exact: true });
      await preview.waitFor();
      assert.equal(await preview.getByRole('button', { name: '确认安装', exact: true }).isEnabled(), true);
      return { draft, preview };
    }
    async function confirm(draft, preview) {
      await preview.getByRole('button', { name: '确认安装', exact: true }).click();
      const applied = await until(async () => (await call('state.get')).drafts.find(value => value.id === draft.id && value.status === 'applied'), 'component installation');
      assert.ok(applied.receipt?.ids.length);
      await preview.getByRole('button', { name: '确认安装', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await preview.getByRole('button', { name: '确认安装', exact: true }).count(), 0);
      const repeated = await call('components.confirm', { draftId: draft.id, expectedVersion: draft.version });
      assert.deepEqual(repeated.receipt, applied.receipt, 'Repeated confirmation returns the same installed identities');
      return applied;
    }

    await resize(1500);
    await enter('skill', 'create');
    await page.getByText('先配置一个模型源，即可开始对话。', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
    checks.push('No configured model: management chat opens with unsent seed and clear setup guidance');
    const source = await call('sources.save', { name: 'Isolated component model', baseUrl: modelBase, models: [
      { id: 'component-tools', name: 'Component tools', supportsTools: true },
      { id: 'component-text', name: 'Text only', supportsTools: false },
    ] });
    await call('settings.defaultModel', { model: { sourceId: source.id, modelId: 'component-tools' } });
    const generatedPluginFiles = {
      'workday-plugin.json': manifest('generated-component-plugin', 'Generated component plugin'),
      'skills/summary/SKILL.md': skillText('generated-package-summary'),
      'mcp.json': JSON.stringify({ name: 'Generated package MCP', transport: 'http', command: '', args: [], url: 'https://fixture.invalid/generated' }),
    };
    const scenarios = [
      { kind: 'skill', intent: 'create', proposal: { files: [{ path: 'SKILL.md', content: skillText('generated-component-fixture') }, { path: 'references/example.md', content: 'Generated supporting resource' }] } },
      { kind: 'skill', intent: 'import', material: skillDirectory, readPath: 'SKILL.md' },
      { kind: 'mcp', intent: 'create', proposal: { servers: [{ name: 'Generated standalone MCP', transport: 'http', command: '', args: [], url: 'https://fixture.invalid/standalone' }] } },
      { kind: 'mcp', intent: 'import', material: mcpFile, readPath: 'mcp.json' },
      { kind: 'plugin', intent: 'create', proposal: { files: Object.entries(generatedPluginFiles).map(([path, content]) => ({ path, content })) } },
      { kind: 'plugin', intent: 'import', material: pluginDirectory, readPath: 'workday-plugin.json' },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await resize(index % 2 ? 660 : 1500);
      const conversation = await enter(scenario.kind, scenario.intent);
      if (scenario.intent === 'import') {
        const originalState = await call('state.get');
        await app.evaluate(() => { globalThis.__componentSmoke.material = null; });
        await page.getByRole('button', { name: '选择本地材料', exact: true }).click();
        await until(async () => await page.getByRole('button', { name: '选择本地材料', exact: true }).isEnabled(), 'canceled material picker');
        assert.equal((await call('components.session', { conversationId: conversation.id })).materials.length, 0);
        const afterCancel = await call('state.get');
        for (const table of ['skills', 'mcpServers', 'plugins', 'drafts']) assert.equal(afterCancel[table].length, originalState[table].length, 'Cancel does not create partial components');
        await app.evaluate((_, selected) => { globalThis.__componentSmoke.material = selected; }, scenario.material);
        await page.getByRole('button', { name: '选择本地材料', exact: true }).click();
        await until(async () => (await call('components.session', { conversationId: conversation.id })).materials.length === 1, 'selected component material');
        await page.locator('.component-material').waitFor();
      }
      if (scenario.kind === 'skill' && scenario.intent === 'create') {
        await app.evaluate((_, file) => { globalThis.__componentSmoke.attachments = [file]; }, attachment);
        await page.getByRole('button', { name: '添加上下文', exact: true }).click();
        await page.getByRole('menuitem', { name: '上传附件', exact: true }).click();
        await page.getByRole('button', { name: '移除附件 reference.txt', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '移除上下文 Skill 管理助手', exact: true }).count(), 0);
      }
      await frame(`${scenario.kind}-${scenario.intent}-composer.png`);
      const { draft, preview } = await sendProposal(conversation, scenario, `COMPONENT_${index}_${mode}`);
      if (scenario.kind === 'skill' && scenario.intent === 'import') {
        assert.equal(draft.files.length, Object.keys(skillFiles).length, 'Complete directory file list is not truncated');
        await preview.locator('.component-draft-files > summary').click();
        assert.equal(await preview.locator('.component-draft-file').count(), Object.keys(skillFiles).length);
        const reference = preview.locator('.component-draft-file').filter({ has: page.locator('summary span', { hasText: 'references/long.md' }) });
        await reference.locator('summary').click();
        await reference.getByRole('button', { name: '加载更多', exact: true }).waitFor();
        while (await reference.getByRole('button', { name: '加载更多', exact: true }).count()) {
          await reference.getByRole('button', { name: '加载更多', exact: true }).click();
          await until(async () => !(await reference.getByRole('button', { name: '加载更多', exact: true }).count()) || await reference.getByRole('button', { name: '加载更多', exact: true }).isEnabled(), 'text page loaded');
        }
        assert.equal(await reference.locator('pre').innerText(), longReference, 'Unicode pagination preserves all characters');
        const binary = preview.locator('.component-draft-file').filter({ has: page.locator('summary span', { hasText: 'assets/pixel.png' }) });
        await binary.locator('summary').click();
        await binary.getByText('此文件为二进制资源，将随组件一同安装。', { exact: true }).waitFor();
        await reference.locator('summary').click();
        await preview.locator('.component-draft-files > summary').click();
        checks.push('Complete imported file list, Unicode text pagination, and binary resource preview');
      }
      await preview.scrollIntoViewIfNeeded();
      const layout = await preview.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { right: rect.right, width: rect.width, viewport: innerWidth, scroll: element.scrollWidth, client: element.clientWidth };
      });
      assert.ok(layout.right <= layout.viewport + 1 && layout.width > 100, JSON.stringify(layout));
      assert.ok(layout.scroll <= layout.client + 1, 'Proposal does not overflow at narrow or wide size');
      await frame(`${scenario.kind}-${scenario.intent}-proposal.png`);
      const applied = await confirm(draft, preview);
      const installed = await call('state.get');
      if (scenario.kind === 'skill') {
        const skill = installed.skills.find(value => value.id === applied.receipt.ids[0]);
        assert.ok(skill.installation);
        const installedDirectory = path.join(data, skill.installation.root);
        if (scenario.intent === 'import') {
          for (const [file, value] of Object.entries(skillFiles)) {
            assert.equal(sha(await fs.readFile(path.join(installedDirectory, file))), sha(value.bytes ?? value), file);
            if (value.mode) assert.equal((await fs.stat(path.join(installedDirectory, file))).mode & 0o777, value.mode, file + ' mode');
          }
          await fs.rm(skillDirectory, { recursive: true });
          assert.equal(await fs.readFile(path.join(installedDirectory, 'references/long.md'), 'utf8'), longReference);
        } else assert.equal(await fs.readFile(path.join(installedDirectory, 'references/example.md'), 'utf8'), 'Generated supporting resource');
      } else if (scenario.kind === 'mcp') {
        assert.equal(applied.receipt.ids.length, scenario.intent === 'import' ? 2 : 1);
        assert.ok(applied.receipt.ids.every(id => installed.mcpServers.some(server => server.id === id && !server.enabled && !server.discoveredAt)));
      } else {
        const plugin = installed.plugins.find(value => value.id === applied.receipt.ids[0]);
        assert.ok(plugin?.skillIds.length === 1 && plugin.mcpIds.length === 1);
        assert.ok(installed.skills.some(value => value.id === plugin.skillIds[0] && value.ownerPluginId === plugin.id && value.installation));
        assert.ok(installed.mcpServers.some(value => value.id === plugin.mcpIds[0] && value.ownerPluginId === plugin.id && !value.enabled));
        if (scenario.intent === 'import') {
          const owned = installed.skills.find(value => value.id === plugin.skillIds[0]);
          const installedRoot = path.join(data, owned.installation.root);
          for (const [file, bytes] of Object.entries(pluginFiles)) assert.equal(sha(await fs.readFile(path.join(installedRoot, file))), sha(bytes), file);
          await fs.rm(pluginDirectory, { recursive: true });
          assert.equal(await fs.readFile(path.join(installedRoot, 'skills/summary/references/example.md'), 'utf8'), 'Complete package resource');
        }
      }
      assert.equal(installed.grants.length, 0);
      assert.equal(installed.pendingSkillRuns.length, 0);
      checks.push(`${title(scenario.kind, scenario.intent)}: UI entry → actual local HTTP read/propose tools → preview → confirmation → installed entities/resources; repeat confirmation is idempotent`);
    }
    assert.ok(JSON.stringify(bodies).includes('SYNTHETIC_ATTACHMENT_REMAINS_AVAILABLE'), 'Regular attachment content still reaches the selected model');
    checks.push('Normal attachment upload remains available in internal management mode and actual model requests');

    const discardChat = await enter('skill', 'create');
    const discardPlan = { kind: 'skill', intent: 'create', proposal: { files: [{ path: 'SKILL.md', content: skillText('discarded-component-fixture') }] } };
    const discarded = await sendProposal(discardChat, discardPlan, 'COMPONENT_DISCARD');
    await discarded.preview.getByRole('button', { name: '放弃', exact: true }).click();
    await until(async () => (await call('state.get')).drafts.some(draft => draft.id === discarded.draft.id && draft.status === 'discarded'), 'discarded proposal');
    assert.ok(!(await call('state.get')).skills.some(skill => skill.name === 'discarded-component-fixture'));
    await discarded.preview.getByRole('button', { name: '确认安装', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await discarded.preview.getByRole('button', { name: '确认安装', exact: true }).count(), 0);
    checks.push('Discard removes installation action and creates no component');

    const inactiveChat = await enter('skill', 'create');
    const inactivePlan = { kind: 'skill', intent: 'create', proposal: { files: [{ path: 'SKILL.md', content: skillText('inactive-component-fixture') }] } };
    const inactive = await sendProposal(inactiveChat, inactivePlan, 'COMPONENT_INACTIVE');
    await page.getByRole('button', { name: '结束管理', exact: true }).click();
    await until(async () => !(await call('components.session', { conversationId: inactiveChat.id })).active, 'ended management revokes session immediately');
    await until(async () => (await call('state.get')).drafts.some(draft => draft.id === inactive.draft.id && draft.status === 'unavailable'), 'proposal revoked without sending another message');
    await inactive.preview.getByRole('button', { name: '确认安装', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await inactive.preview.getByRole('button', { name: '确认安装', exact: true }).count(), 0);
    await page.getByRole('button', { name: '前往插件', exact: true }).waitFor();
    await frame('inactive-management-chat.png');
    checks.push('Ending management immediately revokes the pending proposal and shows restart guidance');

    await call('settings.defaultModel', { model: { sourceId: source.id, modelId: 'component-text' } });
    await enter('mcp', 'create');
    await page.getByText('创建和导入需要支持工具的模型。请选择支持工具的模型后继续。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
    checks.push('Text-only model is clearly rejected before sending a management request');

    const runtime = await app.evaluate(({ app }) => ({ executable: process.execPath, userData: app.getPath('userData'), electron: process.versions.electron }));
    assert.equal(await fs.realpath(runtime.userData), data);
    assert.deepEqual(await app.evaluate(() => globalThis.__componentSmoke.denied), []);
    assert.deepEqual(fixtureErrors, []);
    assert.deepEqual(errors, []);
    const finalState = await call('state.get');
    assert.equal(finalState.grants.length, 0);
    assert.ok(finalState.mcpServers.every(server => !server.enabled && !server.discoveredAt));
    const result = { passed: true, mode, checks, entries: entries.map(({ kind, intent }) => ({ kind, intent })), frames, runtime,
      actualHttpRequests: bodies.length, actualToolCalls: wireCalls, realModel: false, realCredentials: false, personalData: false,
      mcpConnections: 0, scriptRuns: 0, pageErrors: errors };
    await fs.writeFile(results, JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: true, mode, checks: checks.length, actualHttpRequests: bodies.length, results }));
  } catch (error) {
    const notices = page ? await page.locator('[role="alert"]').allTextContents().catch(() => []) : [];
    const diagnostic = page ? await page.evaluate(async () => ({ text: document.body.innerText, state: await window.workday.call('state.get', {}) })).catch(() => null) : null;
    const operations = app ? await app.evaluate(() => globalThis.__componentSmoke.operations).catch(() => []) : [];
    const failure = { passed: false, mode, error: String(error), checks, frames, fixtureErrors, errors, notices, diagnostic, operations, actualHttpRequests: bodies.length, wireCalls };
    await fs.writeFile(results, JSON.stringify(failure, null, 2));
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify(failure, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => undefined);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
