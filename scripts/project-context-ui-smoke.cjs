const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.join(root, 'output/playwright', `project-context-ui-${kind}`);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-project-context-ui-'));
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [];
  let app, page;
  async function until(predicate, description) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + description);
  }
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: kind === 'source' ? [root] : [], env, timeout: 30000
    }, { mockHolidays: true });
    page = await app.firstWindow(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, ipcMain, net }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.hide(); window.setSize(1450, 900);
      window.webContents.setBackgroundThrottling(false);
      net.fetch = async () => { throw new Error('All network is disabled in the project context UI fixture'); };
      const now = '2026-10-21T04:00:00Z';
      const entity = id => ({ id, version: 1, createdAt: now, updatedAt: now });
      const context = { date: null, taskIds: [], knowledgeRefs: [], skillRef: null, mcpRefs: [] };
      const source = { ...entity('ui-source'), name: 'Synthetic ordinary model', configVersion: 1, baseUrl: 'https://never-contact.invalid', enabled: true, models: [{ id: 'ordinary', name: 'Ordinary synthetic model', supportsTools: false }], credentialConfigured: false, testedAt: null, testStatus: null };
      const model = { sourceId: source.id, modelId: 'ordinary' };
      const project = { ...entity('ui-project'), name: 'Synthetic linked project', description: '', directory: '/synthetic/nonexistent/project', repository: null, archived: false };
      const titles = ['项目查询历史', '原生 MCP 历史', '旧版无类型工具历史', '旧版空工具历史'];
      const conversations = titles.map((title, index) => ({ ...entity(`chat-${index}`), title, projectId: project.id, model, context, activeRequestId: null, archived: false }));
      const command = '```workday-project\n{"source":"local","operation":"read","path":"src/example.ts"}\n```';
      const projectTool = id => ({ id, kind: 'project', name: 'workday-project', capabilityName: 'local read src/example.ts', arguments: command, result: JSON.stringify({ path: 'src/example.ts', content: 'PROJECT_RAW_RESULT_SENTINEL', coverage: { returned: 1, truncated: false } }), status: 'success' });
      const histories = {};
      conversations.forEach((conversation, index) => {
        const requestId = `history-${index}`;
        const tool = index === 0 ? projectTool('durable-project-call') : index === 1
          ? { id: 'native-call', name: 'fixture-native', arguments: '{}', mcpId: 'synthetic-mcp', result: 'Synthetic native result', status: 'success' }
          : index === 2 ? { id: 'legacy-call', name: 'legacy-tool', arguments: '{}', result: 'Synthetic legacy result', status: 'success' } : null;
        const message = (id, role, content, extra = {}) => ({ id, conversationId: conversation.id, requestId, role, content, status: 'complete', createdAt: now, ...extra });
        histories[conversation.id] = [
          message(`user-${index}`, 'user', 'Synthetic previous question'),
          message(`tool-${index}`, 'tool', index === 0 ? command + '\nPROJECT_RAW_RESULT_SENTINEL' : 'Synthetic tool text', tool ? { toolCalls: [tool] } : {}),
          message(`assistant-${index}`, 'assistant', 'Synthetic answer from linked project')
        ];
      });
      const state = { gitAccount: null, tasks: [], projects: [project], conversations, sources: [source], knowledge: [], skills: [], mcpServers: [], grants: [], plugins: [], drafts: [], schedules: [], runs: [], defaultModel: model, dataDirectory: '/synthetic/isolated-ui-data', appVersion: 'ui-fixture' };
      const fixture = globalThis.__projectContextUI = { state, histories, sent: [], unexpected: [], projectTool, historyWaiters: [], holdHistory: false, inFlight: null };
      const emit = event => window.webContents.send('workday:event', event);
      fixture.startQuery = () => {
        const current = fixture.inFlight;
        emit({ type: 'chatStarted', ...current });
        emit({ type: 'chatTool', ...current, tool: { ...projectTool(`live-${current.requestId}`), status: 'running', result: undefined } });
        emit({ type: 'chatTool', ...current, tool: projectTool(`live-${current.requestId}`) });
        emit({ type: 'chatDelta', ...current, text: 'Synthetic final answer after project query.' });
      };
      fixture.finish = holdHistory => {
        const current = fixture.inFlight;
        const conversation = state.conversations.find(item => item.id === current.conversationId);
        fixture.histories[conversation.id].push(
          { id: `tool-${current.requestId}`, ...current, role: 'tool', content: command + '\nPROJECT_RAW_RESULT_SENTINEL', status: 'complete', createdAt: now, toolCalls: [projectTool(`live-${current.requestId}`)] },
          { id: `answer-${current.requestId}`, ...current, role: 'assistant', content: 'Synthetic final answer after project query.', status: 'complete', createdAt: now }
        );
        conversation.activeRequestId = null;
        fixture.holdHistory = holdHistory;
        emit({ type: 'stateChanged' }); emit({ type: 'chatDone', ...current });
      };
      fixture.releaseHistory = () => { fixture.holdHistory = false; fixture.historyWaiters.splice(0).forEach(resolve => resolve()); };
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (_event, op, input) => {
        const ok = value => ({ ok: true, value });
        if (op === 'state.get') return ok(state);
        if (op === 'conversations.history') {
          if (fixture.holdHistory) await new Promise(resolve => fixture.historyWaiters.push(resolve));
          return ok(histories[input.id]);
        }
        if (op === 'chat.send') {
          fixture.sent.push(input);
          const requestId = `synthetic-send-${fixture.sent.length}`, conversation = conversations.find(item => item.id === input.conversationId);
          const userMessageId = `user-${requestId}`;
          conversation.activeRequestId = requestId;
          fixture.inFlight = { conversationId: conversation.id, requestId };
          histories[conversation.id].push({ id: userMessageId, conversationId: conversation.id, requestId, role: 'user', content: input.text, status: 'complete', createdAt: now });
          return ok({ requestId, userMessageId });
        }
        if (op === 'weather.query') return ok({ status: 'unavailable', location: null, day: null, message: null });
        if (op === 'meetings.query') return ok({ startDate: input.startDate, endDate: input.endDate, timezone: input.timezone, status: 'notFound', meetings: [], message: null });
        if (op === 'holidays.query') return ok({ year: input.year, data: null, status: 'not-found', message: null });
        fixture.unexpected.push(op); throw new Error('Operation is not allowed in this UI fixture: ' + op);
      });
    });
    await page.reload();
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    const openChat = async title => { await page.locator('.conversation-list').getByRole('button', { name: title, exact: true }).click(); await page.getByRole('log', { name: '对话记录', exact: true }).waitFor(); };
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    const conversion = page.getByRole('checkbox', { name: '将已完成的工具结果作为明确标注的参考文本继续', exact: true });
    await openChat('项目查询历史');
    await page.locator('.message.tool').waitFor();
    await input.fill('Synthetic first follow-up');
    assert.equal(await conversion.count(), 0, 'Project-only durable history must not require native tool conversion');
    assert.equal(await send.isEnabled(), true);
    assert.equal(await page.locator('.message.tool .message-meta > span').first().textContent(), '项目查询');
    assert.equal(await page.locator('.message.tool .message-content').count(), 0, 'Raw project command/result must not occupy message text');
    const durableDetails = page.locator('.message.tool details.tool-result');
    assert.equal(await durableDetails.evaluate(element => element.open), false);
    assert.equal(await durableDetails.locator('pre').isVisible(), false);
    assert.match(await durableDetails.locator('summary').innerText(), /^项目查询/);
    assert.equal(await page.getByText('MCP 工具', { exact: true }).count(), 0);
    await durableDetails.locator('summary').click();
    assert.match(await durableDetails.locator('pre').innerText(), /PROJECT_RAW_RESULT_SENTINEL/);
    await durableDetails.locator('summary').click();
    checks.push('durable project-only history enables ordinary send; project label and raw data are collapsed by default with explicit expansion');

    await page.evaluate(() => {
      window.__visibleProjectInternals = [];
      const scan = () => document.querySelectorAll('.message-content').forEach(element => {
        if (element.getClientRects().length && /workday-project|PROJECT_RAW_RESULT_SENTINEL/.test(element.textContent)) window.__visibleProjectInternals.push(element.textContent);
      });
      new MutationObserver(scan).observe(document.querySelector('.messages'), { subtree: true, childList: true, characterData: true }); scan();
    });
    await send.click();
    await until(async () => await app.evaluate(() => globalThis.__projectContextUI.sent.length) === 1, 'first ordinary follow-up submitted');
    await page.getByRole('button', { name: '停止', exact: true }).waitFor();
    await app.evaluate(() => globalThis.__projectContextUI.startQuery());
    await page.locator('.message.assistant details.tool-result summary').filter({ hasText: '项目查询' }).waitFor();
    assert.equal(await page.locator('.message.assistant details.tool-result').evaluate(element => element.open), false);
    assert.equal(await conversion.count(), 0);
    await app.evaluate(() => globalThis.__projectContextUI.finish(true));
    await send.waitFor();
    await input.fill('Synthetic second ordinary turn');
    await until(async () => await send.isEnabled(), 'live in-memory project tool must not block the ordinary next turn');
    assert.equal(await conversion.count(), 0);
    checks.push('in-memory chatTool project result is labelled and collapsed; completion enables the next ordinary turn before durable history arrives');
    await app.evaluate(() => globalThis.__projectContextUI.releaseHistory());
    await page.locator('[data-message-id="answer-synthetic-send-1"]').waitFor();
    assert.equal(await send.isEnabled(), true);
    await send.click();
    await until(async () => await app.evaluate(() => globalThis.__projectContextUI.sent.length) === 2, 'second ordinary follow-up submitted');
    await page.getByRole('button', { name: '停止', exact: true }).waitFor();
    await app.evaluate(() => { globalThis.__projectContextUI.startQuery(); globalThis.__projectContextUI.finish(false); });
    await page.locator('[data-message-id="answer-synthetic-send-2"]').waitFor();
    const submissions = await app.evaluate(() => globalThis.__projectContextUI.sent);
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every(item => !Object.hasOwn(item, 'toolHistoryAsText')));
    assert.deepEqual(await page.evaluate(() => window.__visibleProjectInternals), [], 'Internal project command/data must not flash in normal message text');
    checks.push('two complete ordinary follow-ups use no toolHistoryAsText; query JSON and raw result stay out of visible message text');

    await openChat('原生 MCP 历史');
    await conversion.waitFor(); await input.fill('Synthetic native follow-up');
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.getByText('MCP 工具', { exact: true }).count(), 1);
    await conversion.check(); assert.equal(await send.isEnabled(), true);
    checks.push('native MCP history still requires explicit text conversion for an ordinary model');
    for (const title of ['旧版无类型工具历史', '旧版空工具历史']) {
      await openChat(title); await conversion.waitFor(); await input.fill('Synthetic legacy follow-up');
      assert.equal(await conversion.isChecked(), false);
      assert.equal(await send.isDisabled(), true);
    }
    checks.push('unknown tool calls and legacy role-tool messages without calls remain blocked until explicit conversion');

    await openChat('项目查询历史');
    await input.fill('Synthetic restored history follow-up');
    await until(async () => await page.locator('.message.tool').count() === 3 && await send.isEnabled(), 'restored completed project history works on an ordinary model');
    assert.equal(await conversion.count(), 0);
    assert.ok((await page.locator('details.tool-result').evaluateAll(elements => elements.map(element => element.open))).every(open => !open));
    assert.equal(await page.locator('.message.tool .message-content').count(), 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.screenshot({ path: path.join(output, 'ordinary-project-history.png'), animations: 'disabled' });
    await page.reload();
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await openChat('项目查询历史'); await input.fill('Synthetic reload follow-up');
    await until(async () => await send.isEnabled() && await page.locator('.message.tool').count() === 3, 'page reload restores project queries without native-tool gate');
    assert.equal(await conversion.count(), 0);
    checks.push('conversation switching and renderer reload restore project query history without the native tool blocker');
    assert.deepEqual(errors, []);
    assert.deepEqual(await app.evaluate(() => globalThis.__projectContextUI.unexpected), []);
    const receipt = { passed: true, kind, realElectron: true, executable: await app.evaluate(() => process.execPath), checks, dataDirectory: data, fakeIPC: true, projectQueriesExecutedByFixture: true, realProjectFilesRead: false, realGitHubRequests: false, realModelRequests: false, personalData: false, personalCredentials: false, limitation: 'Renderer/history smoke only; command parsing and prefix-buffering are verified by main-process tests, not simulated model events.' };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'failure-aria.yml'), await page.locator('body').ariaSnapshot()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
    }
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
