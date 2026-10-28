// Isolated Electron acceptance for stop and continuation. All model traffic is local synthetic SSE.
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
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/stop-continue-' + kind));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-stop-continue-smoke-')));
  await fs.mkdir(output, {recursive: true});
  await fs.rm(path.join(output, 'result.json'), {force: true});
  const checks = [], frames = [], errors = [], requests = [], pending = new Map(), attempts = new Map();
  const startedAt = new Date().toISOString(), initialSource = await fingerprint(path.join(root, 'src'));
  let app, page;
  const usage = n => ({prompt_tokens: 100 + n, completion_tokens: 10 + n, total_tokens: 110 + 2 * n});
  const fragments = ['PREFIX_A：第一段合成正文。', 'PREFIX_B：第二段合成正文。', 'TAIL_C：末段合成正文。'];
  const content = (fixture, attempt) => fixture === 'MAIN' ? fragments[attempt - 1] : fixture === 'NEW' && attempt === 1 ? 'NEW_PREFIX：中断前已收到的正文。' : `DONE_${fixture}：新要求已接续。`;
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
      assert.equal(body.model, 'stop-continue-fixture');
      assert.deepEqual(body.stream_options, {include_usage: true});
      const text = body.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      const fixture = text.includes('STOP_NEW_ORIGINAL') ? 'NEW' : text.includes('STOP_FOLLOW') ? 'FOLLOW' : text.includes('STOP_MAIN_ORIGINAL') ? 'MAIN' : null;
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
      if ((fixture === 'MAIN' && attempt === 3) || (fixture === 'NEW' && attempt === 2) || fixture === 'FOLLOW') finish(key, true);
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
  const choose = title => page.locator('.conversation-list').getByRole('button', {name: title, exact: true}).click();
  const currentConversation = async id => (await call('state.get')).conversations.find(c => c.id === id);
  const waitIdle = id => until(async () => !(await currentConversation(id))?.activeRequestId, 'request terminal');
  const latestAssistant = rows => rows.filter(m => m.role === 'assistant').at(-1);
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
      const fixture = globalThis.__stopFixture = {calls: [], blocked: [], retryResults: [], continueResults: [], cancelResults: []};
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
        if (op === 'chat.continue') fixture.continueResults.push({input, result});
        if (op === 'chat.cancel') fixture.cancelResults.push({input, result});
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
    const source = await call('sources.save', {name: 'Stop isolated source', baseUrl: base + '/v1', models: [{id: 'stop-continue-fixture', name: '合成中断模型', supportsTools: true}]});
    const model = {sourceId: source.id, modelId: 'stop-continue-fixture'};
    await call('settings.defaultModel', {model});
    await page.getByRole('button', {name: '项目', exact: true}).click();
    const input = () => page.getByRole('textbox', {name: '消息输入', exact: true});
    const stop = () => page.getByRole('button', {name: /^停止(?:生成)?$/});
    const continueButton = id => article(id).getByRole('button', {name: '继续生成', exact: true});
    const countText = (body, token) => body.messages.reduce((n, message) => n + (JSON.stringify(message.content).split(token).length - 1), 0);
    async function create(fixture) {
      const chat = await call('conversations.create', {title: '中断隔离 ' + fixture, projectId: null, date: null, model});
      await choose(chat.title);
      return chat;
    }
    async function begin(chat, text, fixture) {
      const before = requests.length;
      await input().fill(text);
      await page.getByRole('button', {name: '发送消息', exact: true}).click();
      await until(() => requests.length > before, 'model accepted ' + fixture);
      await stop().waitFor();
      return latestAssistant(await history(chat.id));
    }
    async function stopped(chat) {
      const before = await app.evaluate(() => globalThis.__stopFixture.cancelResults.length);
      await stop().click();
      await until(async () => await app.evaluate(() => globalThis.__stopFixture.cancelResults.length) > before, 'cancel result after settlement');
      assert.equal((await currentConversation(chat.id)).activeRequestId, null, 'cancel result confirms terminal state');
      const rows = await history(chat.id), current = latestAssistant(rows);
      assert.equal(current.status, 'cancelled');
      await article(current.id).waitFor();
      await continueButton(current.id).waitFor();
      return current;
    }
    const main = await create('MAIN');
    await input().fill('STOP_MAIN_ORIGINAL：仅用于隔离验收。');
    const sendBounds = await page.getByRole('button', {name: '发送消息', exact: true}).boundingBox();
    await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await until(() => pending.has('MAIN:1'), 'first partial stream');
    await stop().waitFor();
    await until(async () => await stop().isEnabled(), 'Stop ready after send acceptance');
    await page.mouse.move(1, 1);
    assert.equal((await stop().innerText()).trim(), '', 'Stop control must contain no visible text');
    const stopStyle = await stop().evaluate(element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return {width:r.width,height:r.height,radius:s.borderRadius,background:s.backgroundColor,color:s.color}; });
    assert.ok(Math.abs(stopStyle.width - stopStyle.height) < 1, 'Stop is square circular footprint');
    assert.ok(Math.abs(stopStyle.width - sendBounds.width) < 1 && Math.abs(stopStyle.height - sendBounds.height) < 1, 'Stop and Send share footprint');
    assert.ok(parseFloat(stopStyle.radius) >= stopStyle.width / 2 || /%/.test(stopStyle.radius), 'Stop has circular radius');
    const graphic = await stop().locator('.stop-square').evaluate(element => { const r=element.getBoundingClientRect(),s=getComputedStyle(element);return {width:r.width,height:r.height,background:s.backgroundColor,color:s.color,hidden:element.getAttribute('aria-hidden')}; });
    assert.equal(graphic.hidden, 'true');
    assert.ok(graphic.width >= 8 && graphic.width <= stopStyle.width / 2 && Math.abs(graphic.width-graphic.height)<1, 'Stop has visible compact filled square');
    const luminance = css => {
      const channel=css.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);});
      return channel[0]*0.2126+channel[1]*0.7152+channel[2]*0.0722;
    };
    const a=luminance(graphic.background),b=luminance(stopStyle.background),contrast=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
    assert.ok(graphic.background !== 'rgba(0, 0, 0, 0)' && contrast>=3, 'Filled Stop square has visible contrast: '+contrast);
    await fs.writeFile(path.join(output,'stop-style.json'),JSON.stringify({stopStyle,graphic},null,2));
    await stop().locator('..').hover();
    await until(async () => (await page.getByRole('tooltip').allTextContents()).some(t => /停止/.test(t)), 'Stop tooltip');
    checks.push('Icon-only accessible circular Stop matches Send footprint');
    await frame('stop-icon-streaming.png');
    await input().fill('保留这条尚未发送的补充要求。');
    const first = await stopped(main), firstRows = await history(main.id), user = firstRows.find(m => m.role === 'user');
    assert.equal(first.content, fragments[0]);
    assert.equal(await input().inputValue(), '保留这条尚未发送的补充要求。');
    assert.ok(first.metrics && first.metrics.durationMs >= 0, 'Cancelled request has duration');
    assert.equal(await article(user.id).locator('.message-actions').count(), 0);
    assert.ok(!(await article(first.id).innerText()).includes('未加入后续上下文'));
    const firstMetrics = structuredClone(first.metrics);
    checks.push('Stop settles cancelled state, preserves partial text/draft/metrics, and user has no actionbar');
    await frame('stopped-with-draft.png');

    await continueButton(first.id).click();
    await until(() => pending.has('MAIN:2'), 'first continue partial stream');
    await until(async () => (await app.evaluate(() => globalThis.__stopFixture.continueResults.length)) === 1, 'continue accepted');
    let rows = await history(main.id), second = latestAssistant(rows);
    await until(async () => (await article(second.id).innerText()).includes('PREFIX_B'), 'new text appended after existing prefix');
    assert.equal(countText(requests[1].body, 'STOP_MAIN_ORIGINAL'), 1);
    assert.equal(countText(requests[1].body, 'PREFIX_A'), 1);
    assert.equal(countText(requests[1].body, 'PREFIX_B'), 0);
    assert.equal(rows.filter(m => m.role === 'user').length, 1);
    assert.equal(await page.locator('article.user').count(), 1);
    assert.equal(await input().inputValue(), '保留这条尚未发送的补充要求。');
    const continued = await app.evaluate(() => globalThis.__stopFixture.continueResults[0]);
    assert.equal(continued.input.conversationId, main.id);
    assert.equal(continued.input.requestId, first.requestId);
    assert.equal(continued.result.ok, true);
    await until(async () => await article(first.id).count() === 0, 'earlier cancelled block replaced');
    assert.equal((await article(second.id).innerText()).split('PREFIX_A').length - 1, 1);
    checks.push('Actual Continue targets exact cancelled request; single original user and prefix preserved once without clearing draft');
    await frame('continue-running.png');

    second = await stopped(main);
    assert.equal(second.content, fragments[0] + fragments[1]);
    await reloadChat(main, second);
    assert.equal((await article(second.id).innerText()).split('PREFIX_A').length - 1, 1);
    assert.equal((await article(second.id).innerText()).split('PREFIX_B').length - 1, 1);
    const beforeContinue = requests.length;
    await continueButton(second.id).click({clickCount: 2, delay: 0});
    await until(() => requests.length > beforeContinue, 'second continuation accepted');
    await waitIdle(main.id);
    rows = await history(main.id);
    const final = latestAssistant(rows);
    await article(final.id).waitFor();
    assert.equal(final.status, 'complete');
    assert.equal(final.content, fragments.join(''));
    assert.equal(attempts.get('MAIN'), 3, 'Double Continue does not duplicate requests');
    assert.equal(countText(requests[2].body, 'PREFIX_A'), 1);
    assert.equal(countText(requests[2].body, 'PREFIX_B'), 1);
    assert.equal(countText(requests[2].body, 'TAIL_C'), 0);
    assert.deepEqual(rows.find(m => m.id === first.id).metrics, firstMetrics);
    assert.deepEqual(final.metrics.usage, {inputTokens:103,outputTokens:13,totalTokens:116});
    assert.equal(rows.filter(m => m.role === 'user').length, 1);
    await until(async () => await page.locator('article.assistant').count() === 1, 'one continuous final reply');
    await reloadChat(main, final);
    assert.equal((await article(final.id).innerText()).split('PREFIX_A').length - 1, 1);
    checks.push('Repeated stop/continue and reload retain one coherent answer, prevent duplicate requests and preserve independent metrics');
    await frame('continued-complete-reloaded.png');

    await send('STOP_FOLLOW：依据之前所有内容继续回答。', 'FOLLOW', main.id);
    const following = requests.find(r => r.fixture === 'FOLLOW').body;
    for (const token of ['STOP_MAIN_ORIGINAL','PREFIX_A','PREFIX_B','TAIL_C','STOP_FOLLOW']) assert.equal(countText(following, token), 1, 'history contains exactly once: ' + token);
    checks.push('New send after repeated continuation carries original question and each answered segment exactly once');

    const next = await create('NEW');
    await begin(next, 'STOP_NEW_ORIGINAL：新要求路径的原始问题。', 'NEW');
    await input().fill('STOP_NEW_FOLLOW：打断后立即补充的新要求。');
    const cancelled = await stopped(next);
    assert.equal(cancelled.content, 'NEW_PREFIX：中断前已收到的正文。');
    await page.getByRole('button', {name: '发送消息', exact: true}).click();
    await until(() => attempts.get('NEW') === 2, 'new request accepted immediately after stop');
    await waitIdle(next.id);
    const nextBody = requests.filter(r => r.fixture === 'NEW')[1].body;
    for (const token of ['STOP_NEW_ORIGINAL','NEW_PREFIX','STOP_NEW_FOLLOW']) assert.equal(countText(nextBody, token), 1);
    assert.equal((await history(next.id)).filter(m => m.role === 'user').length, 2);
    assert.equal(await input().inputValue(), '');
    checks.push('Stop then immediate Send uses retained draft and original interrupted context exactly once');
    await frame('stop-new-instruction.png');

    await create('NARROW');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(760, 760));
    await input().fill('布局验收');
    const narrow = await page.locator('.composer-input').evaluate(element => ({client:element.clientWidth,scroll:element.scrollWidth}));
    assert.ok(narrow.scroll <= narrow.client + 1, 'Composer has no horizontal overflow');
    checks.push('Narrow composer remains usable without horizontal overflow');
    await frame('narrow-composer.png');

    const isolation = await app.evaluate(() => ({blocked: globalThis.__stopFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls, retries: globalThis.__stopFixture.retryResults.length}));
    assert.deepEqual(isolation.blocked, []);
    assert.equal(isolation.nativeCalls, 0);
    assert.equal(isolation.credentialCalls, 0);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 6);
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
