const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { createMockServer } = require('./mock-model.cjs');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  await fs.mkdir(path.join(root, 'test-data'), { recursive: true });
  const data = await fs.mkdtemp(path.join(root, 'test-data', `chat-navigation-${kind}-`));
  const output = process.env.WORKDAY_SMOKE_OUTPUT ? path.resolve(process.env.WORKDAY_SMOKE_OUTPUT) : path.join(root, 'output', 'playwright', 'chat-navigation', kind);
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const mock = createMockServer();
  await new Promise((resolve, reject) => { mock.server.once('error', reject); mock.server.listen(0, '127.0.0.1', resolve); });
  const checks = [], errors = [], turns = [], previewShadows = []; let app, page;
  const context = { date: null, taskIds: [], knowledgeRefs: [], skillRef: null, mcpRefs: [] };
  async function call(op, input) {
    const result = await page.evaluate(({ op, input }) => window.workday.call(op, input), { op, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  async function until(predicate, description) {
    const end = Date.now() + 20000;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + description);
  }
  const marks = () => page.locator('nav.chat-jump button');
  const message = id => page.locator(`article[data-message-id="${id}"]`);
  async function requestDone(conversationId, sent, status = 'complete') {
    let reply;
    await until(async () => {
      const conversation = (await call('state.get', {})).conversations.find(c => c.id === conversationId);
      const history = await call('conversations.history', { id: conversationId });
      reply = history.find(m => m.requestId === sent.requestId && m.role === 'assistant');
      return !conversation.activeRequestId && reply?.status === status;
    }, `${sent.requestId} ${status}`);
    await message(reply.id).waitFor();
    if (reply.content) await until(async () => (await message(reply.id).locator('.message-content').innerText()).replace(/\s+/g, ' ').trim() === reply.content.replace(/\*\*|^#{1,6}\s/gm, '').replace(/\s+/g, ' ').trim(), 'committed reply text is semantically rendered');
    else await until(async () => await message(reply.id).locator('.message-content').count() === 0, 'empty failed reply has no placeholder');
    return reply;
  }
  async function layout() {
    return page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect();
      const messages = document.querySelector('.messages');
      const outer = ['html', 'body', '.workspace', '.conversation-column', '.chat', '.chat-transcript'].map(selector => {
        const element = document.querySelector(selector); return [selector, element.scrollTop, element.scrollLeft];
      });
      return { composer: { top: composer.top, bottom: composer.bottom, left: composer.left, right: composer.right }, outer, scrollTop: messages.scrollTop };
    });
  }
  async function jump(index, keyboard = false) {
    const before = await layout(), mark = marks().nth(index), id = turns[index].id;
    if (keyboard) { await mark.focus(); await mark.press('Enter'); } else await mark.click();
    await until(async () => await mark.getAttribute('aria-current') === 'location' && await message(id).evaluate(element => document.activeElement === element), 'jump activates and focuses target');
    const after = await layout();
    assert.deepEqual(after.outer, before.outer, 'jump never scrolls the window, workspace or conversation ancestors');
    for (const key of Object.keys(before.composer)) assert.ok(Math.abs(after.composer[key] - before.composer[key]) <= 1, 'composer stays fixed while jumping');
    const target = await message(id).evaluate(element => {
      const box = element.getBoundingClientRect(), viewport = element.closest('.messages').getBoundingClientRect();
      return { offset: box.top - viewport.top, viewportHeight: viewport.height };
    });
    assert.ok(target.offset >= -1 && target.offset <= 14, `turn ${index + 1} is at the transcript top (${target.offset})`);
    assert.equal(await page.locator('.chat-jump [aria-current="location"]').count(), 1);
    return { before, after };
  }
  async function preview(index, reply) {
    await page.mouse.move(0, 0);
    await marks().nth(index).hover();
    const tooltip = page.getByRole('tooltip').filter({ has: page.locator('.chat-jump-preview') });
    await tooltip.waitFor();
    const shadow = await tooltip.evaluate(element => getComputedStyle(element).boxShadow);
    assert.notEqual(shadow, 'none', 'chat jump preview must retain its configured shadow');
    previewShadows.push({ theme: await page.evaluate(() => document.documentElement.dataset.theme), shadow });
    assert.equal(await tooltip.locator('strong').textContent(), turns[index].content.slice(0, 300));
    assert.equal(await tooltip.locator('.chat-jump-preview > span').textContent(), reply.slice(0, 500));
    return tooltip;
  }
  async function closePreview() {
    await page.mouse.move(0, 0);
    await until(async () => await page.locator('.chat-jump-preview').count() === 0, 'preview closes');
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    const executable = await app.evaluate(() => process.execPath), versions = await app.evaluate(() => ({ ...process.versions }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
    await page.waitForFunction(() => innerWidth === 1500);
    const source = await call('sources.save', { name: '跳转测试本地源', baseUrl: `http://127.0.0.1:${mock.server.address().port}/v1`, models: [{ id: 'workday-mock', name: '本地模型', supportsTools: false }] });
    const model = { sourceId: source.id, modelId: 'workday-mock' };
    await call('settings.defaultModel', { model });
    const chat = await call('conversations.create', { title: '快速跳转隔离测试', projectId: null, date: null, model });
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.locator('.conversation-list').getByRole('button', { name: chat.title, exact: true }).click();
    await page.getByRole('log', { name: '对话记录', exact: true }).waitFor();
    assert.equal(await marks().count(), 0);
    assert.equal(await page.locator('.chat-heading,.chat-context,.destination,.messages .empty').count(), 0);
    await page.screenshot({ path: path.join(output, 'empty-chat.png'), animations: 'disabled' });
    for (let index = 0; index < 6; index++) {
      const content = `第 ${index + 1} 轮长消息哨兵\n` + Array.from({ length: 10 }, (_, line) => `第 ${line + 1} 行：用于验证跳转只滚动历史消息，输入框及外层布局保持稳定。`).join('\n');
      const sent = await call('chat.send', { conversationId: chat.id, text: content, model, context });
      const reply = await requestDone(chat.id, sent);
      turns.push({ id: sent.userMessageId, content, reply: reply.content });
      await message(sent.userMessageId).waitFor();
      await until(async () => await marks().count() === (index ? index + 1 : 0), 'one jump mark per user turn, hidden for a single turn');
    }
    assert.equal(await page.locator('.messages').evaluate(element => element.scrollHeight > element.clientHeight + 500), true);
    checks.push('empty and single-turn chats hide navigation; six long user turns create six anchors and a scrollable transcript without removed header UI');

    await preview(2, turns[2].reply);
    await page.screenshot({ path: path.join(output, 'chat-navigation-wide.png'), animations: 'disabled' });
    await closePreview();
    const first = await jump(0); assert.ok(first.before.scrollTop - first.after.scrollTop > 50, 'first turn jump moves up from latest');
    const middle = await jump(3); assert.ok(middle.after.scrollTop - middle.before.scrollTop > 50, 'middle turn jump moves within transcript');
    await jump(1, true);
    checks.push('hover previews the selected user and assistant; mouse and keyboard jumps focus the right anchor, update the active mark, and scroll only message history');

    await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('慢速回复哨兵：阅读历史时继续生成。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    let slowUser;
    await until(async () => {
      slowUser = (await call('conversations.history', { id: chat.id })).find(m => m.role === 'user' && m.content.startsWith('慢速回复哨兵'));
      return !!slowUser && await marks().count() === 7;
    }, 'slow turn is present while streaming');
    turns.push({ id: slowUser.id, content: slowUser.content });
    assert.ok((await call('state.get', {})).conversations.find(c => c.id === chat.id).activeRequestId, 'slow response is still generating');
    await jump(1);
    const reading = await layout(), initialText = await page.locator('.message.assistant .message-content').last().textContent();
    await until(async () => (await page.locator('.message.assistant .message-content').last().textContent()).length > initialText.length + 3, 'stream continues after navigating to history');
    assert.ok(Math.abs((await layout()).scrollTop - reading.scrollTop) <= 1, 'stream delta does not pull the reader to latest');
    const slowReply = await requestDone(chat.id, { requestId: slowUser.requestId }); turns.at(-1).reply = slowReply.content;
    assert.ok(Math.abs((await layout()).scrollTop - reading.scrollTop) <= 1, 'final persisted reply does not pull the reader to latest');
    assert.equal(await marks().nth(1).getAttribute('aria-current'), 'location');
    checks.push('jumping to an old turn during live generation keeps the reading position through subsequent deltas and completion');

    const failedText = '失败一次：重试回复预览哨兵';
    const failed = await call('chat.send', { conversationId: chat.id, text: failedText, model, context });
    const failedReply = await requestDone(chat.id, failed, 'failed'); turns.push({ id: failed.userMessageId, content: failedText });
    await until(async () => await marks().count() === 8, 'failed turn has one anchor');
    await preview(7, failedReply.content); await closePreview();
    const retry = await call('chat.retry', { conversationId: chat.id, userMessageId: failed.userMessageId });
    assert.equal(retry.userMessageId, failed.userMessageId);
    const retriedReply = await requestDone(chat.id, retry); turns.at(-1).reply = retriedReply.content;
    const failureNotice = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await failureNotice.count()) await failureNotice.click();
    assert.equal(await marks().count(), 8); assert.equal(await message(failed.userMessageId).count(), 1);
    assert.notEqual(retriedReply.content, failedReply.content);
    await preview(7, retriedReply.content); await closePreview();
    checks.push('a failed reply and its retry share one user anchor; the preview switches to the latest successful assistant attempt without adding a mark');

    const history = await call('conversations.history', { id: chat.id });
    const other = await call('conversations.create', { title: '另一个空聊天', projectId: null, date: null, model });
    await preview(2, turns[2].reply);
    await page.locator('.conversation-list').getByRole('button', { name: other.title, exact: true }).click();
    await until(async () => await page.locator('.message').count() === 0 && await marks().count() === 0 && await page.locator('.chat-jump-preview').count() === 0, 'new conversation clears old anchors and preview');
    await page.locator('.conversation-list').getByRole('button', { name: chat.title, exact: true }).click();
    await until(async () => await marks().count() === 8 && await message(retriedReply.id).count() === 1, 'return restores all anchors and latest reply');
    assert.deepEqual(await call('conversations.history', { id: chat.id }), history);
    assert.deepEqual(await page.locator('.message.user').evaluateAll(elements => elements.map(element => element.dataset.messageId)), turns.map(turn => turn.id));
    checks.push('conversation switching removes stale navigation and tooltip; returning restores the same message IDs and intact history');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 620));
    await page.waitForFunction(() => innerWidth === 660);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await jump(0); await jump(3, true);
    const tooltip = await preview(3, turns[3].reply), bounds = await tooltip.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 661, 'narrow-window preview stays inside viewport');
    assert.equal(await page.locator('.composer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1), true);
    await page.screenshot({ path: path.join(output, 'chat-navigation-narrow.png'), animations: 'disabled' });
    await closePreview();
    checks.push('660x620 retains keyboard/mouse jumping, fixed composer and in-viewport preview without horizontal overflow');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '主题', exact: true }).click();
    await page.getByRole('button', { name: '黑白', exact: true }).click();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await jump(2); await preview(2, turns[2].reply);
    await page.screenshot({ path: path.join(output, 'chat-navigation-mono.png'), animations: 'disabled' });
    await closePreview();
    assert.deepEqual(errors, []); assert.equal(mock.requests.length, 9); assert.ok(mock.requests.every(request => !request.authorization));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, realElectron: true, executable, versions, checks, previewShadows, dataDirectory: data, userTurns: turns.length, modelRequests: mock.requests.length, modelNetwork: '127.0.0.1 controlled fixture', publicModelRequests: false, personalData: false, personalCredentials: false }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) {
      await fs.writeFile(path.join(output, 'failure-aria.yml'), await page.locator('body').ariaSnapshot()).catch(() => {});
      await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close(); mock.server.closeAllConnections(); await new Promise(resolve => mock.server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
