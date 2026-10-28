const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'network-transport-' + kind), output = path.join(root, 'output', 'playwright', 'network-transport', kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'result.json'), { force: true });
  const fake = 'transport-only-fake-key', seen = [], checks = []; let streamClosed = false, abortClosed = false, targetRequests = 0, app;
  const target = http.createServer((req, res) => { targetRequests++; res.end('unexpected'); });
  await new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve); });
  const targetUrl = `http://127.0.0.1:${target.address().port}/target`;
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, fakeAuthorization: req.headers.authorization === 'Bearer ' + fake, cookie: req.headers.cookie ?? null });
    if (req.url === '/redirect') { res.writeHead(302, { Location: targetUrl }); return res.end(); }
    if (req.url === '/abort') { res.on('close', () => { abortClosed = true; }); return; }
    if (req.url === '/stream' || req.url === '/stream-abort') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"中文"},"finish_reason":null}]}\n\n');
      if (req.url === '/stream') return res.end('data: {"choices":[{"delta":{"content":" reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"."},"finish_reason":null}]}\n\n'), 50);
      res.on('close', () => { clearInterval(timer); streamClosed = true; }); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'response-cookie=ignored; Path=/' });
    res.end(JSON.stringify({ data: [{ id: 'local-model', object: 'model' }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'packaged' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    const result = await app.evaluate(async ({ app, session }, { base, fake }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { safeFetch, readCompletion } = require('./dist/main/network.js');
      const { modelUrl } = require('./dist/main/validation.js');
      const headers = { Authorization: 'Bearer ' + fake }, result = { versions: { electron: process.versions.electron, node: process.versions.node }, executable: process.execPath };
      await session.defaultSession.cookies.set({ url: base, name: 'session-cookie', value: 'not-for-models' });
      result.catalog = await (await safeFetch(base + '/models', { headers, credentials: 'include' }, modelUrl)).json();
      result.secondCatalog = await (await safeFetch(base + '/models-again', { headers }, modelUrl)).json();
      result.responseCookieStored = (await session.defaultSession.cookies.get({ url: base })).some(cookie => cookie.name === 'response-cookie');
      try { await safeFetch(base + '/redirect', { headers, redirect: 'follow' }, modelUrl); result.redirectRejected = false; } catch { result.redirectRejected = true; }
      try { await safeFetch(base + '/abort', { headers, signal: AbortSignal.timeout(150) }, modelUrl); result.abortRejected = false; } catch { result.abortRejected = true; }
      const response = await safeFetch(base + '/stream', { headers }, modelUrl); let deltas = '';
      result.stream = await readCompletion(response, text => { deltas += text; }); result.deltas = deltas;
      const controller = new AbortController();
      const streaming = await safeFetch(base + '/stream-abort', { headers, signal: controller.signal }, modelUrl);
      try { await readCompletion(streaming, () => controller.abort()); result.streamAbortRejected = false; } catch { result.streamAbortRejected = true; }
      return result;
    }, { base, fake });
    assert.equal(result.catalog.data[0].id, 'local-model'); assert.equal(result.secondCatalog.data[0].id, 'local-model');
    assert.ok(seen.every(request => request.fakeAuthorization && request.cookie === null)); assert.equal(result.responseCookieStored, false);
    checks.push('production safeFetch uses real Chromium HTTP; explicit Bearer preserved, existing and response cookies omitted');
    assert.equal(result.redirectRejected, true); assert.equal(targetRequests, 0);
    checks.push('redirect error overrides caller follow; redirect target receives no requests or credentials');
    assert.equal(result.abortRejected, true); assert.equal(result.streamAbortRejected, true);
    for (let i = 0; i < 100 && (!abortClosed || !streamClosed); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(abortClosed, true); assert.equal(streamClosed, true);
    checks.push('timeout before headers and AbortSignal during streaming reject and close server connections');
    assert.equal(result.stream.content, '中文 reply'); assert.equal(result.deltas, result.stream.content); assert.deepEqual(result.stream.calls, []);
    checks.push('SSE UTF-8 deltas, finish reason and DONE complete through production readCompletion');
    const receipt = { passed: true, kind, ...result, checks, requests: seen, targetRequests, abortClosed, streamClosed, dataDirectory: data, personalCredentials: false, actualPublicModelNetwork: false, network: 'real Chromium net.fetch to controlled local HTTP servers' };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } finally { if (app) await app.close(); for (const current of [server, target]) { current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
