const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), data = await fs.mkdtemp(path.join(os.tmpdir(), 'workday-connection-result-'));
  const output = path.join(root, 'output/playwright', process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'connection-result-stage' : 'connection-result'); await fs.mkdir(output, {recursive: true});
  let mode = 'success', release, requests = 0, app;
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    for await (const _ of req) {} requests++;
    const outcome = mode;
    if (outcome === 'hold') await new Promise(resolve => { release = resolve; });
    res.writeHead(outcome === 'fail' ? 500 : 200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: 'OK'}}]}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {...process.env, WORKDAY_DATA_DIR: data}; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [];
  try {
    app = await launchWithWeatherFixture(_electron, {
      executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'),
      args: process.env.WORKDAY_ELECTRON_EXECUTABLE ? [] : [root], env, timeout: 30000
    }, {mockHolidays: true});
    const page = await app.firstWindow(); page.setDefaultTimeout(8000);
    await app.evaluate(({ipcMain}) => {
      const original = ipcMain._invokeHandlers.get('workday:call'); globalThis.__pendingTests = 0;
      ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, payload) => {
        if (op !== 'sources.test') return original(event, op, payload);
        globalThis.__pendingTests++;
        try { return await original(event, op, payload); } finally { globalThis.__pendingTests--; }
      });
    });
    const call = async (op, payload) => { const r = await page.evaluate(({op, payload}) => window.workday.call(op, payload), {op, payload}); assert.equal(r.ok, true, JSON.stringify(r)); return r.value; };
    const until = async predicate => { for (let i = 0; i < 160; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('UI condition timed out'); };
    await page.getByRole('navigation', {name: '全局导航'}).waitFor();
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`, models = ['model-a', 'model-b'].map(id => ({id, name: id, supportsTools: false}));
    const a = await call('sources.save', {name: 'Source A', baseUrl, models});
    await call('sources.save', {name: 'Source B', baseUrl, models});
    await page.getByRole('button', {name: '设置', exact: true}).click();
    const table = page.getByRole('table');
    assert.deepEqual((await table.getByRole('columnheader').allTextContents()).map(text => text.trim()), ['模型']);
    for (const [index, model] of models.entries()) {
      assert.deepEqual((await table.locator('tbody tr').nth(index).getByRole('cell').allTextContents()).map(text => text.trim()), [model.name]);
    }
    checks.push('model catalog avoids duplicate IDs when the model name already equals its ID');
    const result = page.locator('.connection-result'), select = page.getByRole('combobox', {name: '选择测试模型'});
    assert.equal(await result.innerText(), '尚未测试');
    assert.equal(await page.getByText('测试发送固定短消息，可能产生服务费用，不携带聊天或知识库内容。保存配置后需独立测试。', {exact: true}).count(), 0);
    mode = 'hold';
    await page.getByRole('button', {name: '测试连接', exact: true}).dblclick();
    await until(() => requests === 1 && !!release);
    assert.match(await result.innerText(), /正在测试/); assert.equal(await select.isDisabled(), true);
    assert.equal(await page.getByRole('button', {name: '测试中…', exact: true}).isDisabled(), true);
    release(); release = null;
    await until(async () => (await result.innerText()).includes('连接成功'));
    assert.match(await result.innerText(), /model-a/); assert.equal(requests, 1);
    assert.equal(await page.getByRole('button', {name: '关闭提示', exact: true}).count(), 0);
    checks.push('busy locks repeated clicks; success appears inline with actual model; no message toast');
    await select.selectOption('model-b'); assert.match(await result.innerText(), /model-a/);
    mode = 'fail'; await page.getByRole('button', {name: '测试连接', exact: true}).click();
    await until(async () => (await result.innerText()).includes('HTTP 500'));
    assert.equal(await result.getAttribute('role'), 'alert'); assert.match(await result.innerText(), /model-b/);
    assert.equal(await page.getByRole('button', {name: '关闭提示', exact: true}).count(), 0);
    await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    mode = 'hold'; await page.getByRole('button', {name: '测试连接', exact: true}).click(); await until(() => !!release);
    assert.doesNotMatch(await result.innerText(), /HTTP 500|连接成功/);
    release(); release = null; await until(async () => (await result.innerText()).includes('连接成功'));
    checks.push('model switch retains previous result identity; HTTP failure stays inline; retry replaces stale error');
    await page.getByRole('button', {name: 'Home', exact: true}).click(); await page.getByRole('button', {name: '设置', exact: true}).click();
    assert.match(await result.innerText(), /上次测试：连接成功/); assert.doesNotMatch(await result.innerText(), /model-a|model-b/);
    await page.screenshot({path: path.join(output, 'success.png'), fullPage: true});
    checks.push('returning to settings shows saved last result without inventing its model identity');
    mode = 'hold'; await page.getByRole('button', {name: '测试连接', exact: true}).click(); await until(() => !!release);
    await page.locator('.source-card').filter({hasText: 'Source B'}).click(); assert.equal(await result.innerText(), '尚未测试');
    release(); release = null; await until(() => app.evaluate(() => globalThis.__pendingTests === 0));
    assert.equal(await result.innerText(), '尚未测试');
    await page.locator('.source-card').filter({hasText: 'Source A'}).click();
    await page.getByRole('button', {name: '测试连接', exact: true}).click(); await until(() => !!release);
    const current = (await call('state.get', {})).sources.find(s => s.id === a.id);
    await call('sources.save', {id: a.id, expectedVersion: current.version, name: current.name, baseUrl, models});
    await until(async () => (await result.innerText()) === '尚未测试');
    release(); release = null; await until(() => app.evaluate(() => globalThis.__pendingTests === 0));
    await page.getByRole('button', {name: '测试连接', exact: true}).waitFor();
    assert.equal(await result.innerText(), '尚未测试'); assert.equal(await page.getByRole('button', {name: '关闭提示', exact: true}).count(), 0);
    checks.push('switching source or config isolates late test completions and conflicts');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({passed: true, checks, modelService: 'loopback fixture', personalCredentials: false, paidRequests: false, isolatedData: data}, null, 2));
    console.log(JSON.stringify({passed: true, checks}, null, 2));
  } finally { release?.(); if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
