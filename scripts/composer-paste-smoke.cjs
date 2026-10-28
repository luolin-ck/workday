const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

function png() {
  function crc(bytes) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
  function chunk(name, bytes) { const t = Buffer.from(name), h = Buffer.alloc(4), c = Buffer.alloc(4); h.writeUInt32BE(bytes.length); c.writeUInt32BE(crc(Buffer.concat([t, bytes]))); return Buffer.concat([h, t, bytes, c]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(80); header.writeUInt32BE(60, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(321 * 60); for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) { const i = y * 321 + 1 + x * 4; pixels[i] = 72 + x; pixels[i + 1] = 120 + y; pixels[i + 2] = 204; pixels[i + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('Comment\0PASTE_METADATA_REMOVE')), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source', red = process.argv.includes('--red');
  const output = process.env.WORKDAY_SMOKE_OUTPUT ? path.resolve(process.env.WORKDAY_SMOKE_OUTPUT) : path.join(root, 'output/playwright/composer-paste-' + kind), data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-paste-smoke-')));
  await fs.mkdir(output, { recursive: true });
  if (!red) { await fs.rm(path.join(output, 'result.json'), { force: true }); await fs.rm(path.join(output, 'failure.json'), { force: true }); }
  const checks = [], frames = [], errors = [], requests = [], probes = [];
  const startedAt = new Date().toISOString();
  async function fingerprint(directory) {
    const files = [];
    async function visit(relative = '') { for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const name = path.join(relative, entry.name); if (entry.isDirectory()) await visit(name); else if (entry.isFile()) files.push({ path: name, sha256: createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex') }); } }
    await visit(); return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), fileCount: files.length };
  }
  const server = http.createServer(async (req, res) => {
    try { assert.equal(req.url, '/v1/chat/completions'); let raw = ''; for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 20 * 1024 * 1024); } const body = JSON.parse(raw); assert.equal(body.model, 'paste-fixture'); requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'PASTE_SYNTHETIC_REPLY' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); }
    catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Synthetic fixture failure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const base = `http://127.0.0.1:${server.address().port}`;
  let app, page;
  const input = () => page.getByRole('textbox', { name: '消息输入', exact: true });
  const call = async (op, payload = {}) => { const result = await page.evaluate(({ op, payload }) => window.workday.call(op, payload), { op, payload }); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  async function until(predicate, label, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw Error('Timed out: ' + label); }
  async function frame(name) { const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')); assert.ok(bytes.length > 1000); await fs.writeFile(path.join(output, name), Buffer.from(bytes, 'base64')); frames.push(name); }
  // This fixture supplies only the trust bit to the production preload listener.
  // It does not access the system clipboard and is never evidence of native paste.
  const preloadFixture = path.join(data, 'paste-fixture-preload.cjs');
  await fs.writeFile(preloadFixture, `const originalAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if (type !== 'paste' || typeof listener !== 'function') return originalAdd.call(this, type, listener, options);
  return originalAdd.call(this, type, function(event) {
    if (event.clipboardData?.getData('application/x-workday-paste-fixture') !== 'synthetic-gesture') return listener.call(this, event);
    return listener.call(this, new Proxy(event, { get(target, key) { if (key === 'isTrusted') return true; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }));
  }, options);
};`);
  async function paste(files, text = '', fixtureGesture = true) {
    await input().focus();
    return input().evaluate((element, { files, text, fixtureGesture }) => {
      const clipboardData = new DataTransfer();
      if (text) clipboardData.setData('text/plain', text);
      if (fixtureGesture) clipboardData.setData('application/x-workday-paste-fixture', 'synthetic-gesture');
      for (const file of files) clipboardData.items.add(new File([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], file.name, { type: file.type }));
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return { isTrusted: event.isTrusted, types: [...clipboardData.types], fileCount: clipboardData.files.length, prevented: event.defaultPrevented };
    }, { files: files.map(file => ({ name: file.name, type: file.type, data: file.bytes.toString('base64') })), text, fixtureGesture });
  }
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env, timeout: 30000 }, { mockHolidays: true, keychain: true });
    page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.route(/^https?:\/\//, route => route.abort());
    await app.evaluate(({ app, BrowserWindow, clipboard, dialog, ipcMain, net }, { data, base, preloadFixture }) => {
      if (app.getPath('userData') !== data) throw Error('Fixture data isolation mismatch');
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setBackgroundThrottling(false); window.setSize(1320, 900); window.showInactive();
      window.webContents.session.registerPreloadScript({ type: 'frame', filePath: preloadFixture });
      globalThis.__pasteFixture = { files: [], delay: 0, pasteDelay: 0, cancel: false, calls: [], pasted: [], blocked: [], clipboardReads: 0 };
      // Deny all system clipboard access. Native Finder/image checks belong to CUA.
      clipboard.read = async () => { globalThis.__pasteFixture.clipboardReads++; throw Error('System clipboard read blocked in isolated smoke'); };
      clipboard.readText = async () => { throw Error('System clipboard read blocked'); }; clipboard.write = async () => { throw Error('System clipboard write blocked'); }; clipboard.writeText = async () => { throw Error('System clipboard write blocked'); };
      dialog.showOpenDialog = async options => { if (options.title !== '添加聊天附件') throw Error('Unexpected dialog'); const fixture = globalThis.__pasteFixture; await new Promise(resolve => setTimeout(resolve, fixture.delay)); return { canceled: fixture.cancel, filePaths: fixture.cancel ? [] : [...fixture.files] }; };
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', async (event, op, payload) => { const fixture = globalThis.__pasteFixture; if (['sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'mcp.readResource', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save'].includes(op)) { fixture.blocked.push(op); throw Error('External operation blocked'); } if (['chat.send', 'context.attachments.pick', 'context.attachments.preview', 'context.attachments.remove'].includes(op)) fixture.calls.push({ op, payload }); return original(event, op, payload); });
      const pasteHandler = ipcMain._invokeHandlers.get('workday:paste');
      if (pasteHandler) { ipcMain.removeHandler('workday:paste'); ipcMain.handle('workday:paste', async (event, owner, files) => { const record = { owner, files: files.map(file => ({ name: file.name, size: file.bytes.byteLength })) }; globalThis.__pasteFixture.pasted.push(record); await new Promise(resolve => setTimeout(resolve, globalThis.__pasteFixture.pasteDelay)); const result = await pasteHandler(event, owner, files); record.result = result; return result; }); }
      const originalFetch = net.fetch.bind(net); net.fetch = (url, init) => { const target = new URL(typeof url === 'string' ? url : url.url ?? url.href); if (target.origin !== base && !['ipwho.is', 'geocoding-api.open-meteo.com', 'api.open-meteo.com', 'sousuo.www.gov.cn'].includes(target.hostname)) { globalThis.__pasteFixture.blocked.push(target.origin); throw Error('Only fixture provider allowed'); } return originalFetch(url, init); };
    }, { data, base, preloadFixture });
    await page.reload(); await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await input().waitFor();
    const source = await call('sources.save', { name: 'Paste synthetic source', baseUrl: base + '/v1', models: [{ id: 'paste-fixture', name: '粘贴模拟模型', supportsTools: true }] });
    const model = { sourceId: source.id, modelId: 'paste-fixture' }; await call('settings.defaultModel', { model });
    const picture = { name: 'synthetic-paste.png', type: 'image/png', bytes: png() };
    await input().fill('保留的正文'); probes.push(await paste([picture]));
    try { await page.getByRole('button', { name: '移除附件 synthetic-paste.png', exact: true }).waitFor({ timeout: 2500 }); }
    catch (error) {
      if (red) { await frame('red-missing-paste-preview.png'); await fs.writeFile(path.join(output, 'red.json'), JSON.stringify({ expectedBehaviorMissing: true, assertion: 'Pasted image enters shared Home composer as removable preview', actual: await page.locator('.composer-attachment').count(), input: await input().inputValue(), probes, trust: 'Synthetic listener fixture; native system clipboard not accessed', kind, actualHttpBodies: requests.length }, null, 2)); throw Error('BUSINESS RED: pasted image missing from composer'); }
      throw error;
    }
    assert.equal(red, false, 'Red mode expected original behavior to be absent');
    checks.push('Synthetic gesture reaches real preload/main and normalized composer preview');
    await until(() => page.locator('.composer-attachment img').count().then(n => n === 1), 'normalized image preview');
    const previewBytes = Buffer.from((await page.locator('.composer-attachment img').getAttribute('src')).split(',')[1], 'base64');
    assert.equal(previewBytes.includes(Buffer.from('PASTE_METADATA_REMOVE')), false);
    assert.equal(previewBytes.readUInt32BE(16), 80); assert.equal(previewBytes.readUInt32BE(20), 60);
    assert.equal(await input().inputValue(), '保留的正文');
    await frame('home-paste-wide.png');
    const latestPaste = () => app.evaluate(() => globalThis.__pasteFixture.pasted.at(-1));
    const owner = (await latestPaste()).owner, imageRef = (await latestPaste()).result.value[0];
    const noGesture = await page.evaluate(owner => window.workday.pasteAttachments(owner), owner); assert.equal(noGesture.ok, false);
    probes.push(await paste([{ name: 'untrusted.png', type: 'image/png', bytes: png() }], '', false));
    await until(() => page.locator('.composer-attachment-error').count().then(n => n === 1), 'untrusted event error');
    assert.equal(await page.locator('.composer-attachment').count(), 1); assert.equal((await latestPaste()).result.value[0].token, imageRef.token);
    const crossOwner = await page.evaluate(({ owner, token }) => window.workday.call('context.attachments.preview', { owner: { ...owner, draftKey: 'another-draft' }, tokens: [token] }), { owner, token: imageRef.token }); assert.equal(crossOwner.ok, false);
    const fakePath = await page.evaluate(owner => window.workday.call('context.attachments.paste', { owner, path: '/not-authorized.txt' }), owner); assert.equal(fakePath.ok, false);
    const badOrigin = await app.evaluate(async ({ ipcMain }, owner) => ipcMain._invokeHandlers.get('workday:paste')({ sender: null, senderFrame: null }, owner, []), owner); assert.equal(badOrigin.ok, false); assert.equal(badOrigin.error.code, 'ORIGIN');
    const wrongFocus = await page.evaluate(async owner => { const field = document.createElement('textarea'); document.body.append(field); field.focus(); const data = new DataTransfer(); data.setData('application/x-workday-paste-fixture', 'synthetic-gesture'); data.items.add(new File(['SYNTHETIC'], 'wrong-target.txt', { type: 'text/plain' })); field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); const result = await window.workday.pasteAttachments(owner); field.remove(); return result; }, owner); assert.equal(wrongFocus.ok, false);
    checks.push('No gesture, replay and untrusted DOM paste cannot consume preload handoff; cross-owner preview and generic path import are rejected');
    const selected = { name: '资料与代码说明很长很长的文件名用于省略展示.ts', type: 'text/plain', bytes: Buffer.from('const synthetic = "PASTE_SELECTED_CODE_SENTINEL";\n') };
    await input().fill('前后'); await input().evaluate(element => element.setSelectionRange(1, 1));
    probes.push(await paste([selected], '中间\n文字'));
    await page.getByRole('button', { name: '移除附件 ' + selected.name, exact: true }).waitFor(); assert.equal(await input().inputValue(), '前中间\n文字后');
    assert.equal(await page.locator('.context-chip').filter({ hasText: selected.name }).count(), 0);
    const removed = { name: 'remove-me.txt', type: 'text/plain', bytes: Buffer.from('PASTE_REMOVED_SENTINEL') };
    await paste([removed]); await page.getByRole('button', { name: '移除附件 remove-me.txt', exact: true }).focus(); await page.getByRole('button', { name: '移除附件 remove-me.txt', exact: true }).press('Enter');
    await until(() => page.getByRole('button', { name: '移除附件 remove-me.txt', exact: true }).count().then(n => n === 0), 'removed file disappears');
    const pdf = { name: 'synthetic-document.pdf', type: 'application/pdf', bytes: await fs.readFile(path.join(root, 'tests/fixtures/attachment-compressed.pdf')) };
    await paste([pdf]); await page.getByRole('button', { name: '移除附件 synthetic-document.pdf', exact: true }).waitFor();
    const skill = await call('skills.save', { name: '粘贴写作规范', description: 'Synthetic paste Skill', content: 'PASTE_SELECTED_SKILL_SENTINEL' });
    await input().fill('@粘贴写作规范'); await page.getByRole('listbox', { name: '上下文建议', exact: true }).getByRole('option').filter({ hasText: '粘贴写作规范' }).click();
    await page.getByRole('button', { name: '移除上下文 粘贴写作规范', exact: true }).waitFor();
    await input().fill('/'); await page.getByRole('listbox', { name: '快捷命令', exact: true }).waitFor(); assert.equal(await page.getByRole('listbox', { name: '快捷命令', exact: true }).getByRole('option').count(), 7); await input().press('Escape');
    await frame('home-mixed-attachments-wide.png');
    async function sent(text, key) {
      const before = requests.length; await input().fill(text);
      if (key) await input().press(key); else await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await until(() => Promise.resolve(requests.length === before + 1), 'one real localhost HTTP body');
      const captured = await app.evaluate(() => globalThis.__pasteFixture.calls.filter(call => call.op === 'chat.send').at(-1));
      await until(async () => !(await call('state.get')).conversations.find(item => item.id === captured.payload.conversationId)?.activeRequestId, 'synthetic reply ended');
      return { body: requests.at(-1), payload: captured.payload };
    }
    const homeSend = await sent('PASTE_HOME_SEND', 'Meta+Enter'), homeWire = JSON.stringify(homeSend.body);
    assert.match(homeWire, /PASTE_SELECTED_CODE_SENTINEL/); assert.match(homeWire, /SYNTHETIC ROOT PDF/); assert.match(homeWire, /PASTE_SELECTED_SKILL_SENTINEL/); assert.doesNotMatch(homeWire, /PASTE_REMOVED_SENTINEL|PASTE_METADATA_REMOVE/);
    assert.deepEqual(homeSend.payload.context.skillRef, { id: skill.id, version: skill.version }); assert.equal(homeSend.payload.context.attachmentRefs.length, 3);
    const userContent = homeSend.body.messages.filter(message => message.role === 'user').at(-1).content; assert.equal(Array.isArray(userContent), true);
    const sentImages = userContent.filter(part => part.type === 'image_url'); assert.equal(sentImages.length, 1); assert.equal(sentImages[0].image_url.url, 'data:image/png;base64,' + previewBytes.toString('base64'));
    assert.equal(await page.locator('.composer-attachment').count(), 0);
    const usedPreview = await page.evaluate(({ owner, token }) => window.workday.call('context.attachments.preview', { owner, tokens: [token] }), { owner: homeSend.payload.owner, token: imageRef.token }); assert.equal(usedPreview.ok, false);
    checks.push('Image, code and PDF traverse real normalization and localhost model request; mixed text inserts once; removal excludes bytes; @ Skill and Cmd+Enter preserve actual selection; consumed tokens cannot preview');
    const textProbe = await paste([], 'ordinary/path.txt', false); assert.equal(textProbe.prevented, false); assert.equal(await page.locator('.composer-attachment').count(), 0); probes.push(textProbe);
    await input().fill('错误后保留正文');
    await paste([{ name: 'atomic-valid.txt', type: 'text/plain', bytes: Buffer.from('DO_NOT_COMMIT_PARTIAL') }, { name: 'invalid.png', type: 'image/png', bytes: Buffer.from('not an image') }]);
    await until(() => page.locator('.composer-attachment-error').count().then(n => n === 1), 'invalid format error'); assert.equal(await page.locator('.composer-attachment').count(), 0); assert.equal(await input().inputValue(), '错误后保留正文');
    await paste([{ name: 'too-large.txt', type: 'text/plain', bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 120) }]);
    await until(() => page.locator('.composer-attachment-error').textContent().then(text => /10 MiB/.test(text)), 'oversized file rejected before IPC'); assert.equal(await page.locator('.composer-attachment').count(), 0);
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `batch-${i}.txt`, type: 'text/plain', bytes: Buffer.from('PASTE_BATCH_' + i) }));
    await paste([...six, { name: 'seventh.txt', type: 'text/plain', bytes: Buffer.from('SEVENTH') }]); await until(() => page.locator('.composer-attachment-error').textContent().then(text => /6/.test(text)), 'seven rejected before transfer'); assert.equal(await page.locator('.composer-attachment').count(), 0);
    await paste(six); await until(() => page.locator('.composer-attachment').count().then(n => n === 6), 'six committed');
    await paste([{ name: 'seventh.txt', type: 'text/plain', bytes: Buffer.from('SEVENTH') }]); await until(() => page.locator('.composer-attachment-error').textContent().then(text => /6/.test(text)), 'cumulative limit'); assert.equal(await page.locator('.composer-attachment').count(), 6);
    await frame('chat-six-files-wide.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 900)); await until(async () => await page.evaluate(() => innerWidth === 660), 'narrow viewport'); await input().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.locator('.composer-input').boundingBox(), sendBounds = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 661); assert.ok(sendBounds && sendBounds.x >= 0 && sendBounds.x + sendBounds.width <= 661);
    const cardHeights = await page.locator('.composer-attachment').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)); assert.ok(cardHeights.every(height => height <= 90));
    await frame('chat-six-files-narrow.png');
    const stripBounds = await page.locator('.composer-attachments').boundingBox(); assert.ok(stripBounds && stripBounds.height <= 170, 'Six attachments stay within two compact rows instead of filling the chat');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 900));
    for (const file of six) await page.getByRole('button', { name: '移除附件 ' + file.name, exact: true }).click();
    await until(() => page.locator('.composer-attachment-status').count().then(n => n === 0), 'last removal releases preparing state');
    await until(() => page.locator('.composer-attachment').count().then(n => n === 0), 'all six removed');
    checks.push('Bad format fails atomically and preserves draft; seven-file batch and cumulative seventh rejected; six compact file chips keep send button within narrow viewport');
    const pickerFile = path.join(data, 'picker-code.ts'); await fs.writeFile(pickerFile, 'PASTE_PICKER_SENTINEL');
    await app.evaluate((_, file) => { globalThis.__pasteFixture.files = [file]; }, pickerFile);
    await input().fill('/attach'); await page.getByRole('listbox', { name: '快捷命令', exact: true }).getByRole('option').filter({ hasText: '上传附件' }).click();
    await page.getByRole('button', { name: '移除附件 picker-code.ts', exact: true }).waitFor();
    const pickerSend = await sent('PICKER_REGRESSION_SEND'); assert.match(JSON.stringify(pickerSend.body), /PASTE_PICKER_SENTINEL/);
    await page.getByRole('button', { name: '添加上下文', exact: true }).click();
    await page.getByRole('menuitem', { name: '上传附件', exact: true }).click();
    await page.getByRole('button', { name: '移除附件 picker-code.ts', exact: true }).waitFor();
    await page.getByRole('button', { name: '移除附件 picker-code.ts', exact: true }).click();
    await until(() => page.locator('.composer-attachment-status').count().then(n => n === 0), 'plus-picked file removed');
    checks.push('/attach and plus menu keep original file picker; selected file reaches real normalized send path');
    const folder = path.join(data, 'project'); await fs.mkdir(folder); const project = await call('projects.save', { name: '粘贴隔离项目', description: 'Synthetic workspace', directory: folder });
    const chatA = await call('conversations.create', { title: '粘贴项目 A', projectId: project.id, date: null, model }), chatB = await call('conversations.create', { title: '粘贴项目 B', projectId: project.id, date: null, model });
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    const chooseChat = name => page.locator('.conversation-list').getByRole('button', { name, exact: true }).click();
    await chooseChat(chatA.title); await input().fill('项目正文');
    await app.evaluate(() => { globalThis.__pasteFixture.pasteDelay = 650; });
    await paste([picture]); await page.getByText('正在准备附件…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true); assert.equal(await input().isEnabled(), true);
    const beforeRepeat = await app.evaluate(() => globalThis.__pasteFixture.pasted.length); await paste([picture]);
    await chooseChat(chatB.title); await chooseChat(chatA.title);
    await until(async () => { const last = await latestPaste(); return Boolean(last?.result); }, 'stale preparation result');
    const staleTokens = (await latestPaste()).result.value.map(ref => ref.token);
    await until(async () => (await app.evaluate((_, tokens) => globalThis.__pasteFixture.calls.some(call => call.op === 'context.attachments.remove' && tokens.every(token => call.payload.tokens.includes(token))), staleTokens)), 'stale cleanup requested');
    assert.equal(await app.evaluate(() => globalThis.__pasteFixture.pasted.length), beforeRepeat); assert.equal(await page.locator('.composer-attachment').count(), 0);
    const stale = await latestPaste(); assert.equal(stale.result.ok, true);
    const stalePreview = await page.evaluate(({ owner, tokens }) => window.workday.call('context.attachments.preview', { owner, tokens }), { owner: stale.owner, tokens: stale.result.value.map(ref => ref.token) }); assert.equal(stalePreview.ok, false);
    await app.evaluate(() => { globalThis.__pasteFixture.pasteDelay = 0; });
    await paste([picture]); await page.getByRole('button', { name: '移除附件 synthetic-paste.png', exact: true }).waitFor();
    await frame('project-image-ready.png'); const projectSend = await sent('');
    assert.equal(projectSend.payload.conversationId, chatA.id); assert.equal(projectSend.payload.context.attachmentRefs.length, 1); assert.match(JSON.stringify(projectSend.body), /data:image\/png;base64,/);
    checks.push('Project chat accepts image-only send; preparing blocks duplicate/send but permits editing; A→B→A invalidates old import and removes its token');
    const isolation = await app.evaluate(() => ({ blocked: globalThis.__pasteFixture.blocked, clipboardReads: globalThis.__pasteFixture.clipboardReads, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls }));
    assert.deepEqual(isolation.blocked, []); assert.equal(isolation.clipboardReads, 0); assert.equal(isolation.nativeCalls, 0); assert.equal(isolation.credentialCalls, 0); assert.deepEqual(errors, []);
    const runtime = await app.evaluate(({ app }, expectedData) => ({ app: app.getAppPath(), executable: app.getPath('exe'), processExecutable: process.execPath, dataDirectoryVerified: app.getPath('userData') === expectedData, isolated: app.getPath('userData') }), data);
    assert.equal(runtime.dataDirectoryVerified, true); assert.equal(runtime.executable, runtime.processExecutable);
    const result = { passed: true, kind, startedAt, completedAt: new Date().toISOString(), source: await fingerprint(path.join(root, 'src')), compiled: await fingerprint(path.join(runtime.app, 'dist')), smokeScriptSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex'), checks, frames, probes, actualHttpBodies: requests.length, httpEvidence: requests.map(body => ({ model: body.model, imageParts: body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length, selectedCode: JSON.stringify(body).includes('PASTE_SELECTED_CODE_SENTINEL'), selectedPdf: JSON.stringify(body).includes('SYNTHETIC ROOT PDF'), removedFile: JSON.stringify(body).includes('PASTE_REMOVED_SENTINEL'), picker: JSON.stringify(body).includes('PASTE_PICKER_SENTINEL') })), nativePasteVerified: false, realModel: false, personalData: false, realCredentials: false, actualMcpCalls: 0, isolation, runtime };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(root, 'test-results', `paste-smoke-${kind}-result-${startedAt.replaceAll(':', '-')}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) { await fs.writeFile(path.join(output, red ? 'red-failure.json' : 'failure.json'), JSON.stringify({ error: String(error), checks, frames, probes, errors, actualHttpBodies: requests.length }, null, 2)); throw error; }
  finally { if (app) await app.close().catch(() => undefined); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await fs.rm(data, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
