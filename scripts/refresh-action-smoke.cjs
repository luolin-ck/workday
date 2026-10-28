// Isolated Electron acceptance for completed-reply refresh. All model traffic is local synthetic SSE.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {_electron} = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const {launchWithWeatherFixture} = require('./electron-fixture-launch.cjs');
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fingerprint(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const item of (await fs.readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, item.name);
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files.push({path: name, sha256: sha256(await fs.readFile(path.join(directory, name)))});
    }
  }
  await visit();
  return {sha256: sha256(JSON.stringify(files)), fileCount: files.length};
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/refresh-action-' + kind));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-refresh-action-smoke-')));
  await fs.mkdir(output, {recursive: true});
  await fs.rm(path.join(output, 'result.json'), {force: true});
  const checks = [], frames = [], errors = [], requests = [], pending = new Map(), attempts = new Map();
  const startedAt = new Date().toISOString(), initialSource = await fingerprint(path.join(root, 'src'));
  let app, page;
  const usage = n => ({prompt_tokens: 100 + n, completion_tokens: 10 + n, total_tokens: 110 + 2 * n});
  const content = (fixture, attempt) => fixture === 'MAIN' ? `合成刷新答复 MAIN_${attempt}。` : `合成成功答复 ${fixture}_${attempt}。`;
  function finish(key, success) {
    const entry = pending.get(key);
    assert.ok(entry, 'Expected pending fixture: ' + key);
    pending.delete(key);
    if (entry.res.destroyed) return;
    if (success) entry.res.write(event({choices: [{delta: {}, finish_reason: 'stop'}]}));
    entry.res.write(event({choices: [], usage: usage(entry.attempt)}));
    entry.res.end(success ? 'data: [DONE]\n\n' : '');
  }
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 1024 * 1024); }
      const body = JSON.parse(raw);
      assert.equal(body.model, 'refresh-action-fixture');
      assert.deepEqual(body.stream_options, {include_usage: true});
      const text = body.messages.filter(m => m.role === 'user').at(-1)?.content;
      assert.equal(typeof text, 'string');
      const fixture = /REFRESH_(MAIN_NEXT|MAIN|ARCHIVE|PREFLIGHT)/.exec(text)?.[1];
      assert.ok(fixture, 'Expected synthetic input');
      const attempt = (attempts.get(fixture) || 0) + 1;
      attempts.set(fixture, attempt);
      requests.push({fixture, attempt, body});
      const key = fixture + ':' + attempt;
      const entry = {fixture, attempt, res};
      pending.set(key, entry);
      res.on('close', () => pending.delete(key));
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      res.write(event({choices: [{delta: {content: content(fixture, attempt)}, finish_reason: null}]}));
      if (fixture !== 'MAIN' || attempt === 1) finish(key, true);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end('Fixture error');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function rawCall(op, input = {}) {
    return page.evaluate(({op, input}) => window.workday.call(op, input), {op, input});
  }
  async function call(op, input = {}) {
    const result = await rawCall(op, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  async function until(test, label) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await test()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('Timed out: ' + label);
  }
  const history = id => call('conversations.history', {id});
  const article = id => page.locator('article[data-message-id="' + id + '"]');
  const refresh = id => article(id).locator('.message-actions').getByRole('button', {name: /重新生成|重试此轮/});
  const choose = title => page.locator('.conversation-list').getByRole('button', {name: title, exact: true}).click();
  const currentConversation = async id => (await call('state.get')).conversations.find(c => c.id === id);
  const waitIdle = id => until(async () => !(await currentConversation(id))?.activeRequestId, 'request terminal');
  const latestAssistant = rows => rows.filter(m => m.role === 'assistant').at(-1);
  const retryCount = () => app.evaluate(() => globalThis.__refreshFixture.retryResults.length);
  const isDisabled = async button => await button.isDisabled() || await button.getAttribute('aria-disabled') === 'true';
  async function keyboardFocusRefresh(id) {
    // Mantine's focus tooltip requires :focus-visible. Enter through a real Tab
    // event after mouse-driven setup instead of testing programmatic focus().
    await page.mouse.move(1, 1);
    await article(id).getByRole('button', {name: '复制消息', exact: true}).focus();
    await page.keyboard.press('Tab');
    const target = await isDisabled(refresh(id)) ? refresh(id).locator('..') : refresh(id);
    assert.equal(await target.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true, 'Refresh is keyboard reachable');
  }
  async function frame(name) {
    const bytes = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {stayHidden: true, stayAwake: true})).toPNG().toString('base64'));
    assert.ok(bytes.length > 1000);
    await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64'));
    frames.push(name);
  }
  async function send(text, fixture, id) {
    const before = attempts.get(fixture) || 0;
    await page.getByRole('textbox', {name: '消息输入', exact: true}).fill(text);
    await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await until(() => (attempts.get(fixture) || 0) > before, 'local model accepted ' + fixture);
    await waitIdle(id);
  }
  async function reloadChat(chat, last) {
    await page.reload();
    await page.getByRole('navigation', {name: '全局导航'}).waitFor();
    await page.getByRole('button', {name: '项目', exact: true}).click();
    await choose(chat.title);
    await article(last.id).waitFor();
  }
  try {
    const env = {...process.env, WORKDAY_DATA_DIR: data};
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, {executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env, timeout: 30000}, {mockHolidays: true, keychain: true});
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\//, route => { errors.push('Unexpected renderer network ' + route.request().url()); return route.abort(); });
    await app.evaluate(({app, BrowserWindow, dialog, ipcMain, net, clipboard}, {data, base}) => {
      if (app.getPath('userData') !== data) throw Error('Fixture isolation mismatch');
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.setSize(1200, 900);
      window.showInactive();
      const fixture = globalThis.__refreshFixture = {calls: [], blocked: [], retryResults: []};
      dialog.showOpenDialog = async () => { throw Error('File picker blocked'); };
      for (const method of ['read', 'readText', 'readImage', 'write', 'writeText', 'writeImage']) clipboard[method] = () => { throw Error('Clipboard blocked'); };
      const original = ipcMain._invokeHandlers.get('workday:call');
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, input) => {
        if (['sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save'].includes(op)) {
          fixture.blocked.push(op); throw Error('External operation blocked');
        }
        fixture.calls.push(op);
        const result = await original(event, op, input);
        if (op === 'chat.retry') fixture.retryResults.push(result);
        return result;
      });
      const originalFetch = net.fetch.bind(net);
      net.fetch = (url, init) => {
        const target = new URL(typeof url === 'string' ? url : url.url ?? url.href);
        if (target.origin !== base && !['ipwho.is', 'geocoding-api.open-meteo.com', 'api.open-meteo.com', 'sousuo.www.gov.cn'].includes(target.hostname)) {
          fixture.blocked.push(target.origin); throw Error('Only localhost provider allowed');
        }
        return originalFetch(url, init);
      };
    }, {data, base});
    await page.getByRole('navigation', {name: '全局导航'}).waitFor();
    const source = await call('sources.save', {name: 'Refresh isolated source', baseUrl: base + '/v1', models: [{id: 'refresh-action-fixture', name: '合成刷新模型', supportsTools: true}]});
    const model = {sourceId: source.id, modelId: 'refresh-action-fixture'};
    await call('settings.defaultModel', {model});
    await page.getByRole('button', {name: '项目', exact: true}).click();
    async function create(fixture) {
      const chat = await call('conversations.create', {title: '刷新隔离 ' + fixture, projectId: null, date: null, model});
      await choose(chat.title);
      await send('REFRESH_' + fixture + '：原始输入仅用于隔离验收。', fixture, chat.id);
      return chat;
    }

    const main = await create('MAIN');
    let rows = await history(main.id);
    const first = latestAssistant(rows), user = rows.find(m => m.role === 'user');
    assert.equal(first.status, 'complete');
    await refresh(first.id).waitFor();
    const labels = await article(first.id).locator('.message-actions button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
    assert.equal(labels.length, 3);
    assert.equal(labels[0], '复制消息');
    assert.match(labels[1], /重新生成|重试此轮/);
    assert.equal(labels[2], '消息详情');
    assert.equal(await article(user.id).locator('.message-actions').count(), 0);
    await keyboardFocusRefresh(first.id);
    await until(async () => (await page.getByRole('tooltip').allTextContents()).some(text => /重新生成|重试此轮/.test(text)), 'accessible refresh tooltip');
    checks.push('Successful reply has accessible refresh between copy and details; user message has no refresh');
    await frame('initial-success-actions.png');
    const firstMetrics = structuredClone(first.metrics);

    const initialRetryCount = await retryCount();
    await refresh(first.id).click({clickCount: 2, delay: 0});
    await until(() => pending.has('MAIN:2'), 'first refresh streaming');
    await until(async () => await retryCount() === initialRetryCount + 1, 'exactly one accepted refresh');
    assert.equal(attempts.get('MAIN'), 2);
    assert.equal(await article(first.id).count(), 1);
    await until(async () => await isDisabled(refresh(first.id)), 'refresh disabled while running');
    assert.deepEqual(requests[1].body.messages, requests[0].body.messages);
    assert.ok(!JSON.stringify(requests[1].body.messages).includes(content('MAIN', 1)));
    assert.equal((await history(main.id)).filter(m => m.role === 'user').length, 1);
    checks.push('Double click starts one refresh; old success stays visible while busy; outbound messages retain original input and exclude old final answer');
    await frame('refresh-running-old-answer.png');
    finish('MAIN:2', true);
    await waitIdle(main.id);
    rows = await history(main.id);
    let current = latestAssistant(rows);
    const second = current;
    assert.equal(current.status, 'complete');
    await until(async () => await article(first.id).count() === 0 && await article(current.id).count() === 1, 'successful replacement visible');
    assert.equal(await page.locator('article.assistant').count(), 1);
    assert.equal(await page.locator('article.user').count(), 1);
    assert.equal(current.replyToMessageId, user.id);
    assert.equal(current.snapshot.replacesMessageId, first.id);
    assert.deepEqual(rows.find(m => m.id === first.id).metrics, firstMetrics);
    assert.deepEqual(current.metrics.usage, {inputTokens: 102, outputTokens: 12, totalTokens: 114});
    await article(current.id).getByRole('button', {name: '消息详情', exact: true}).click();
    const details = page.getByRole('dialog', {name: '消息详情', exact: true});
    await details.waitFor();
    assert.match(await details.innerText(), /114/);
    await frame('refresh-success-metrics.png');
    await page.keyboard.press('Escape');
    await details.waitFor({state: 'detached'});
    checks.push('Successful refresh replaces only original answer, preserves its stored metrics, and exposes independent current usage');

    await refresh(second.id).click();
    await until(() => pending.has('MAIN:3'), 'failing refresh streaming');
    assert.equal(await article(second.id).count(), 1);
    assert.deepEqual(requests[2].body.messages, requests[0].body.messages);
    finish('MAIN:3', false);
    await waitIdle(main.id);
    rows = await history(main.id); current = latestAssistant(rows);
    assert.equal(current.status, 'failed');
    await article(current.id).getByRole('button', {name: '重试此轮', exact: true}).waitFor();
    assert.equal(await article(second.id).count(), 1);
    assert.equal(await page.locator('article.assistant').count(), 2);
    assert.equal(current.snapshot.replacesMessageId, second.id);
    checks.push('Failed completed-reply refresh retains prior success plus the current error');
    await frame('refresh-failed-retains-success.png');

    await article(current.id).getByRole('button', {name: '重试此轮', exact: true}).click();
    await until(() => pending.has('MAIN:4'), 'cancellable refresh streaming');
    await page.getByRole('button', {name: '停止', exact: true}).click();
    await waitIdle(main.id);
    rows = await history(main.id); current = latestAssistant(rows);
    assert.equal(current.status, 'cancelled');
    await article(current.id).getByRole('button', {name: '重试此轮', exact: true}).waitFor();
    assert.equal(await article(second.id).count(), 1);
    assert.equal(await page.locator('article.assistant').count(), 2);
    assert.equal(current.snapshot.replacesMessageId, second.id);
    checks.push('Cancelled continuation retains prior success and latest cancellation while superseded failure disappears');
    await frame('refresh-cancelled-retains-success.png');

    await article(current.id).getByRole('button', {name: '重试此轮', exact: true}).click();
    await until(() => pending.has('MAIN:5'), 'final refresh streaming');
    finish('MAIN:5', true);
    await waitIdle(main.id);
    rows = await history(main.id); current = latestAssistant(rows);
    assert.equal(current.status, 'complete');
    await until(async () => await article(current.id).count() === 1 && await page.locator('article.assistant').count() === 1, 'final replacement visible');
    assert.equal(rows.filter(m => m.role === 'assistant').length, 5);
    assert.equal(rows.filter(m => m.role === 'user').length, 1);
    assert.deepEqual(rows.find(m => m.id === first.id).metrics, firstMetrics);
    assert.deepEqual(current.metrics.usage, {inputTokens: 105, outputTokens: 15, totalTokens: 120});
    assert.equal(current.snapshot.replacesMessageId, second.id);
    for (const request of requests.filter(r => r.fixture === 'MAIN')) assert.deepEqual(request.body.messages, requests[0].body.messages);
    await reloadChat(main, current);
    assert.equal(await page.locator('article.assistant').count(), 1);
    assert.equal(await article(first.id).count(), 0);
    assert.equal(await article(second.id).count(), 0);
    assert.equal(await refresh(current.id).count(), 1);
    checks.push('Success after failed/cancelled chain preserves all five stored attempts; reload retains explicit replacement-chain semantics');
    await frame('refresh-chain-reloaded.png');

    await send('REFRESH_MAIN_NEXT：下一轮合成输入。', 'MAIN_NEXT', main.id);
    rows = await history(main.id);
    const next = latestAssistant(rows);
    await article(next.id).waitFor();
    await until(async () => await isDisabled(refresh(current.id)), 'earlier successful turn disabled');
    await keyboardFocusRefresh(current.id);
    await until(async () => (await page.getByRole('tooltip').allTextContents()).some(text => /仅支持重新生成最新一轮/.test(text)), 'earlier-turn reason');
    const outbound = requests.find(r => r.fixture === 'MAIN_NEXT').body.messages;
    assert.ok(outbound.some(m => m.role === 'user' && m.content === user.content));
    assert.ok(outbound.some(m => m.role === 'assistant' && m.content === current.content));
    assert.ok(outbound.some(m => m.role === 'user' && m.content === 'REFRESH_MAIN_NEXT：下一轮合成输入。'));
    assert.ok(!JSON.stringify(outbound).includes(content('MAIN', 1)));
    const beforeOldRejection = structuredClone(rows), beforeOldRequests = requests.length;
    const olderResult = await rawCall('chat.retry', {conversationId: main.id, userMessageId: user.id});
    assert.equal(olderResult.ok, false);
    assert.deepEqual(await history(main.id), beforeOldRejection);
    assert.equal(requests.length, beforeOldRequests);
    checks.push('Earlier successful turn shows disabled reason and API rejects without mutation; following send contains complete latest conversation history');
    await frame('earlier-success-disabled.png');

    const archived = await create('ARCHIVE'), archivedRows = await history(archived.id), archivedReply = latestAssistant(archivedRows);
    const active = await currentConversation(archived.id);
    await call('conversations.archive', {id: active.id, expectedVersion: active.version, archived: true});
    await page.locator('.archived-chat-notice').waitFor();
    await until(async () => await isDisabled(refresh(archivedReply.id)), 'archived refresh disabled');
    await keyboardFocusRefresh(archivedReply.id);
    await until(async () => (await page.getByRole('tooltip').allTextContents()).some(text => /归档/.test(text)), 'archived reason');
    const archivedResult = await rawCall('chat.retry', {conversationId: archived.id, userMessageId: archivedRows.find(m => m.role === 'user').id});
    assert.equal(archivedResult.ok, false);
    assert.deepEqual(await history(archived.id), archivedRows);
    assert.equal(attempts.get('ARCHIVE'), 1);
    checks.push('Archived success keeps a disabled refresh with an explanation; backend rejects without a new attempt');
    await frame('archived-refresh-disabled.png');

    const preflight = await create('PREFLIGHT'), before = await history(preflight.id), saved = latestAssistant(before);
    await refresh(saved.id).waitFor();
    const currentSource = (await call('state.get')).sources.find(s => s.id === source.id);
    await call('sources.toggle', {id: source.id, expectedVersion: currentSource.version, enabled: false});
    const priorResults = await retryCount();
    await refresh(saved.id).click();
    await until(async () => await retryCount() > priorResults, 'preflight rejection returned');
    assert.equal(await app.evaluate(() => globalThis.__refreshFixture.retryResults.at(-1).ok), false);
    assert.deepEqual(await history(preflight.id), before);
    assert.equal(await article(saved.id).count(), 1);
    assert.equal(attempts.get('PREFLIGHT'), 1);
    checks.push('Actual disabled-source preflight rejection leaves successful answer, metrics, and history intact without sending another request');
    await frame('preflight-rejected-old-answer.png');

    const isolation = await app.evaluate(() => ({blocked: globalThis.__refreshFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls, retries: globalThis.__refreshFixture.retryResults.length}));
    assert.deepEqual(isolation.blocked, []);
    assert.equal(isolation.nativeCalls, 0);
    assert.equal(isolation.credentialCalls, 0);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 8);
    const runtime = await app.evaluate(({app}, expected) => ({app: app.getAppPath(), executable: app.getPath('exe'), processExecutable: process.execPath, dataDirectoryVerified: app.getPath('userData') === expected}), data);
    assert.equal(runtime.dataDirectoryVerified, true);
    assert.equal(runtime.executable, runtime.processExecutable);
    const sourceFingerprint = await fingerprint(path.join(root, 'src'));
    assert.deepEqual(sourceFingerprint, initialSource, 'Source changed while smoke ran');
    const result = {passed: true, kind, startedAt, completedAt: new Date().toISOString(), runtime, source: sourceFingerprint, compiled: await fingerprint(path.join(runtime.app, 'dist')), scriptSha256: sha256(await fs.readFile(__filename)), checks, frames, actualHttpBodies: requests.length, requests, personalData: false, realModel: false, realCredentials: false, actualMcpCalls: 0, isolation};
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({passed: true, kind, checks: checks.length, output}));
  } catch (error) {
    if (page) await frame('failure.png').catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({error: String(error), checks, frames, errors, requests}, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await fs.rm(data, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
