// Isolated acceptance of the real renderer's transcript following and jump-to-bottom control.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('../fixtures/electron-fixture-launch.cjs');

// A deliberately plain, synthetic PNG fixture. It is never read from personal files.
function fixturePng(width = 640, height = 1000) {
  const chunk = (name, bytes) => {
    const body = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const result = Buffer.alloc(body.length + 8); result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels[offset] = 190 + (Math.floor(y / 100) % 2) * 25; pixels[offset + 1] = 215; pixels[offset + 2] = 230;
  }
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function main() {
  const root = path.resolve(__dirname, '../..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'stage' : 'source';
  const appRoot = await fs.realpath(process.env.WORKDAY_APP_ROOT || root);
  const output = path.resolve(process.env.WORKDAY_SMOKE_OUTPUT || path.join(root, 'output/playwright/chat-scroll-' + kind));
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workday-chat-scroll-')));
  const startedAt = new Date().toISOString(), checks = [], frames = [], errors = [], observations = {};
  let app, page;
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const until = async (predicate, label) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
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
  const log = () => page.getByRole('log', { name: '对话记录', exact: true });
  const bottomButton = () => page.getByRole('button', { name: '滚动到底部', exact: true });
  const position = () => log().evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight, remaining: element.scrollHeight - element.scrollTop - element.clientHeight }));
  const atBottom = async () => (await position()).remaining < 3;
  const openChat = title => page.locator('.conversation-list').getByRole('button', { name: title, exact: true }).click();
  const seed = (id, messages) => app.evaluate((_, { id, messages }) => { globalThis.__scrollFixture.histories[id] = messages; }, { id, messages });
  const event = value => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('workday:event', value), value);
  const releaseMedia = artifactId => app.evaluate((_, { artifactId, dataUrl }) => {
    const fixture = globalThis.__scrollFixture; fixture.mediaReady[artifactId] = { ok: true, value: { dataUrl } };
    for (const resolve of fixture.mediaPending[artifactId] || []) resolve(fixture.mediaReady[artifactId]);
    delete fixture.mediaPending[artifactId];
  }, { artifactId, dataUrl: fixturePng() });
  const scrollUp = async () => {
    const box = await log().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100000); await until(async () => (await position()).top < 2, 'wheel scroll reaches older messages');
    await until(async () => await bottomButton().count() === 1, 'reading history shows control');
  };
  const history = (conversationId, rounds = 8) => Array.from({ length: rounds }, (_, index) => {
    const requestId = randomUUID(), userId = randomUUID(), createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    return [{ id: userId, conversationId, requestId, role: 'user', content: `第 ${index + 1} 轮滚动验收`, status: 'complete', createdAt },
      { id: randomUUID(), conversationId, requestId, replyToMessageId: userId, role: 'assistant', content: Array.from({ length: 8 }, (_, line) => `第 ${line + 1} 行：这是隔离生成的验收消息，用于验证进入对话时显示最近回复，阅读历史时不会被新内容强制拉回。`).join('\n\n'), status: 'complete', createdAt }];
  }).flat();
  try {
    const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [appRoot] : [], env, timeout: 30000 }, { mockHolidays: true, keychain: true });
    page = await app.firstWindow(); page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow, ipcMain }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Data isolation mismatch');
      const window = BrowserWindow.getAllWindows()[0]; window.setSize(1400, 900); window.showInactive(); window.webContents.setBackgroundThrottling(false);
      globalThis.__scrollFixture = { histories: {}, mediaPending: {}, mediaReady: {}, mediaReads: [], blocked: [] };
      const original = ipcMain._invokeHandlers.get('workday:call'); ipcMain.removeHandler('workday:call');
      ipcMain.handle('workday:call', (event, op, input) => {
        const fixture = globalThis.__scrollFixture;
        if (op === 'conversations.history' && Object.hasOwn(fixture.histories, input.id)) return { ok: true, value: structuredClone(fixture.histories[input.id]) };
        if (op === 'media.read') {
          fixture.mediaReads.push(input);
          if (fixture.mediaReady[input.artifactId]) return fixture.mediaReady[input.artifactId];
          return new Promise(resolve => { (fixture.mediaPending[input.artifactId] ||= []).push(resolve); });
        }
        if (['chat.send', 'chat.retry', 'chat.continue', 'sources.models', 'sources.test', 'schedules.run', 'mcp.discover', 'mcp.call', 'git.connect', 'git.repositories', 'git.import', 'projects.download', 'skills.approveRun', 'grants.save', 'media.open'].includes(op)) {
          fixture.blocked.push(op); throw Error('External operation blocked');
        }
        return original(event, op, input);
      });
    }, data);
    await page.route(/^https?:\/\//, route => { errors.push('Unexpected renderer network'); return route.abort(); });
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
    // Observe real scroll/resize callbacks without changing the component's layout or behavior.
    await page.evaluate(() => {
      window.__scrollProbe = [];
      const record = (type, extra = {}) => {
        const element = document.querySelector('.messages'), content = document.querySelector('.messages-content');
        window.__scrollProbe.push({ type, time: performance.now(), top: element?.scrollTop, height: element?.scrollHeight, viewport: element?.clientHeight, content: content?.getBoundingClientRect().height, ...extra });
        if (window.__scrollProbe.length > 200) window.__scrollProbe.shift();
      };
      const Original = window.ResizeObserver;
      window.ResizeObserver = class extends Original {
        constructor(callback) { super((entries, observer) => { record('resize-before', { targets: entries.map(entry => entry.target.className) }); callback(entries, observer); record('resize-after'); }); }
        observe(target, options) { record('observe', { target: target.className }); return super.observe(target, options); }
      };
      document.addEventListener('scroll', event => { if (event.target.matches?.('.messages')) record('scroll'); }, true);
      document.addEventListener('wheel', event => { if (event.target.closest?.('.messages')) record('wheel', { delta: event.deltaY }); }, true);
    });
    const source = await call('sources.save', { name: '滚动验收源（不发请求）', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'scroll-fixture', name: '滚动验收模型', supportsTools: false }] });
    const model = { sourceId: source.id, modelId: 'scroll-fixture' }; await call('settings.defaultModel', { model });
    const first = await call('conversations.create', { title: '滚动验收长历史', projectId: null, date: null, model });
    const second = await call('conversations.create', { title: '滚动验收另一对话', projectId: null, date: null, model });
    const messages = history(first.id); await seed(first.id, messages); await seed(second.id, []);
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await openChat(first.title);
    await until(async () => await log().locator('article').count() === messages.length, 'synthetic history renders');
    await until(atBottom, 'enter conversation at bottom');
    assert.ok((await position()).height > (await position()).viewport * 3, 'History genuinely overflows the viewport');
    assert.equal(await bottomButton().count(), 0, 'Bottom control hides while pinned');
    checks.push('A long existing conversation opens at its latest message');
    const initialViewport = await log().boundingBox();
    await page.mouse.move(initialViewport.x + initialViewport.width / 2, initialViewport.y + initialViewport.height / 2);
    await page.mouse.wheel(0, -100000);
    await until(async () => (await position()).top < 2, 'reading older messages');
    await page.waitForTimeout(120);
    assert.equal(await bottomButton().count(), 1, 'BUSINESS RED: scrolling away from bottom must reveal the scroll-to-bottom control above the composer');
    await bottomButton().waitFor({ state: 'visible' });
    await frame('reading-history.png');
    checks.push('Scrolling into history reveals the scroll-to-bottom control');

    const geometry = await bottomButton().evaluate(button => {
      const rect = button.getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect();
      return { width: rect.width, height: rect.height, bottom: rect.bottom, composerTop: composer.top, left: rect.left, right: rect.right, viewport: innerWidth, radius: getComputedStyle(button).borderRadius, svg: button.querySelectorAll('svg').length };
    });
    assert.ok(Math.abs(geometry.width - geometry.height) < 1, 'Bottom control is circular');
    assert.ok(geometry.bottom <= geometry.composerTop + 1 && geometry.composerTop - geometry.bottom < 50, 'Bottom control sits just above the composer');
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport);
    assert.equal(geometry.svg, 1, 'Idle control displays the down arrow');
    await bottomButton().click(); await until(atBottom, 'button returns to latest');
    await until(async () => await bottomButton().count() === 0, 'button hides at bottom');
    checks.push('Idle circular arrow stays above the composer, scrolls down and hides');

    await page.locator('nav.chat-jump button').first().click();
    await until(async () => await bottomButton().count() === 1, 'rail jump shows bottom control');
    assert.ok((await position()).remaining > 100);
    const firstArticle = log().locator(`article[data-message-id="${messages[0].id}"]`);
    assert.equal(await firstArticle.evaluate(element => document.activeElement === element), true, 'Rail retains its keyboard focus behavior');
    await openChat(second.title); await until(async () => await log().locator('article').count() === 0, 'switch to empty conversation');
    assert.equal(await bottomButton().count(), 0);
    await openChat(first.title); await until(async () => await log().locator('article').count() === messages.length, 'switch back loads history');
    await until(atBottom, 'reopening conversation returns to bottom');
    checks.push('Existing rail navigation still works; switching back enters at bottom without a stale control');

    const appendMedia = async label => {
      const artifactId = randomUUID(), messageId = randomUUID();
      messages.push({ id: messageId, conversationId: first.id, requestId: randomUUID(), role: 'assistant', content: label, status: 'complete', createdAt: new Date().toISOString(),
        media: [{ id: artifactId, jobId: randomUUID(), name: 'source.png', mime: 'image/png', bytes: 4096, sha256: 'fixture-only', width: 640, height: 1000, frameCount: 1, relativePath: 'fixture/source.png' }] });
      await seed(first.id, messages); await event({ type: 'chatDone', conversationId: first.id, requestId: randomUUID() });
      const article = log().locator(`article[data-message-id="${messageId}"]`); await article.waitFor();
      await until(() => app.evaluate((_, artifactId) => !!globalThis.__scrollFixture.mediaPending[artifactId]?.length, artifactId), 'media IPC is pending');
      assert.equal(await article.locator('img').count(), 0, 'Image starts as a genuinely pending local media read');
      return { artifactId, article };
    };
    const pinnedMedia = await appendMedia('延迟图片验收：已在底部时继续跟随');
    await until(atBottom, 'media placeholder follows while pinned');
    const placeholder = await position(); await releaseMedia(pinnedMedia.artifactId);
    await until(async () => await pinnedMedia.article.locator('img').evaluate(image => image.complete && image.naturalHeight === 1000), 'delayed media is decoded');
    await until(atBottom, 'delayed image layout growth keeps pinned reader at bottom');
    assert.ok((await position()).height > placeholder.height + 200, 'The image genuinely enlarges the transcript after its placeholder');
    observations.pinnedImageGrowth = (await position()).height - placeholder.height;
    await frame('delayed-image-following.png');
    checks.push('A delayed local image grows naturally and preserves bottom following');
    const readingMedia = await appendMedia('延迟图片验收：阅读历史时不抢滚动');
    await until(atBottom, 'second media placeholder follows'); await scrollUp();
    const readingBefore = await position(); await releaseMedia(readingMedia.artifactId);
    await until(async () => await readingMedia.article.locator('img').evaluate(image => image.complete && image.naturalHeight === 1000), 'second delayed image is decoded');
    await until(async () => (await position()).height > readingBefore.height + 200, 'second image changes real layout');
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await position()).top - readingBefore.top) < 2, 'Media decoded below the reader must not yank history to bottom');
    checks.push('A delayed image below a history reader leaves their scroll position unchanged');

    const requestId = randomUUID(), streamId = `stream-${requestId}`, stream = log().locator(`article[data-message-id="${streamId}"]`);
    await event({ type: 'chatStarted', conversationId: first.id, requestId });
    await event({ type: 'chatDelta', conversationId: first.id, requestId, text: '流式验收开始。\n\n' });
    await stream.waitFor(); await bottomButton().waitFor({ state: 'visible' });
    const dots = bottomButton().locator('.chat-bottom-dots > span');
    assert.equal(await dots.count(), 3, 'Generating uses exactly three activity dots inside the clickable bottom control');
    assert.equal(await bottomButton().locator('svg').count(), 0, 'Activity dots replace the idle arrow while generating');
    observations.dotAnimations = await dots.evaluateAll(elements => elements.map(element => { const style = getComputedStyle(element); return { name: style.animationName, duration: style.animationDuration, delay: style.animationDelay }; }));
    assert.ok(observations.dotAnimations.every(animation => animation.name !== 'none' && parseFloat(animation.duration) > 0), 'All activity dots animate');
    assert.equal(new Set(observations.dotAnimations.map(animation => animation.delay)).size, 3, 'The three dot bounces are staggered');
    const streamReading = await position();
    let streamText = '流式验收开始。\n\n';
    const delta = async text => { streamText += text; await event({ type: 'chatDelta', conversationId: first.id, requestId, text }); await until(async () => (await stream.innerText()).includes(text.trim().slice(-25)), 'stream delta appears'); };
    await delta(Array.from({ length: 12 }, (_, line) => `流式新增第 ${line + 1} 行，阅读上方时应保持原来的位置。`).join('\n\n') + '\n\n');
    assert.ok(Math.abs((await position()).top - streamReading.top) < 2, 'Streaming below a history reader does not pull them down');
    assert.ok((await position()).height > streamReading.height + 100);
    await frame('streaming-dots.png');
    checks.push('Normal streaming events show three staggered dots and do not pull readers away from history');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    observations.reducedAnimations = await dots.evaluateAll(elements => elements.map(element => { const style = getComputedStyle(element); return { name: style.animationName, duration: style.animationDuration }; }));
    assert.ok(observations.reducedAnimations.every(animation => animation.name === 'none' || parseFloat(animation.duration) <= 0.00001), 'Reduced motion disables the dot animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await bottomButton().click(); await until(atBottom, 'clicking animated control returns to bottom');
    await until(async () => await bottomButton().count() === 0, 'animated control hides at bottom');
    const resumed = await position();
    await delta(Array.from({ length: 7 }, (_, line) => `继续跟随第 ${line + 1} 行：点回底部以后持续跟随。`).join('\n\n') + '\n\n');
    await until(atBottom, 'further deltas remain pinned after click');
    assert.ok((await position()).top > resumed.top + 100);
    await stream.focus(); await page.keyboard.press('PageUp');
    await until(async () => (await position()).remaining > 40 && await bottomButton().count() === 1, 'PageUp reads older content');
    // Native PageUp can keep scrolling beyond 200 ms on a busy compositor.
    // Compare streamed growth only after that user-initiated animation settles.
    let keyboardTop = null, keyboardStableSince = Date.now();
    await until(async () => {
      const { top } = await position();
      if (keyboardTop === null || Math.abs(top - keyboardTop) > .5) keyboardStableSince = Date.now();
      keyboardTop = top;
      return Date.now() - keyboardStableSince >= 400;
    }, 'PageUp scroll animation settles');
    const keyboardReading = await position();
    await delta('键盘上翻后新增的流式段落不应改变阅读位置。\n\n');
    observations.keyboardReading = { before: keyboardReading, after: await position() };
    assert.ok(Math.abs((await position()).top - keyboardReading.top) < 2, 'Keyboard scrolling upward cancels automatic following');
    await bottomButton().click(); await until(atBottom, 'click resumes following after keyboard navigation');
    await event({ type: 'chatTool', conversationId: first.id, requestId, tool: { id: 'fixture-tool', name: 'workday-project', kind: 'project', arguments: '{}', status: 'running' } });
    await until(async () => await stream.locator('.tool-call,.tool-calls,details').count() > 0, 'tool area renders');
    await until(atBottom, 'late tool area growth preserves bottom following');
    await scrollUp();
    const finishReading = await position();
    messages.push({ id: streamId, conversationId: first.id, requestId, role: 'assistant', content: streamText, status: 'complete', createdAt: new Date().toISOString() });
    await seed(first.id, messages); await event({ type: 'chatDone', conversationId: first.id, requestId });
    await until(async () => await bottomButton().locator('svg').count() === 1, 'stream completion restores arrow while still reading history');
    assert.ok(Math.abs((await position()).top - finishReading.top) < 2);
    checks.push('Reduced motion stops bouncing; clicking during a stream resumes following including tool content; completion restores the idle arrow');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 700));
    await until(() => page.evaluate(() => innerWidth === 760), 'narrow viewport');
    const narrow = await bottomButton().evaluate(button => {
      const r = button.getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom, composerTop: composer.top, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        outer: ['html', 'body', '.workspace', '.conversation-column', '.chat', '.chat-transcript'].map(selector => [selector, document.querySelector(selector).scrollTop]) };
    });
    assert.ok(narrow.left >= 0 && narrow.right <= narrow.width && narrow.bottom <= narrow.composerTop + 1);
    assert.equal(narrow.overflow, false); assert.ok(narrow.outer.every(([, top]) => top === 0), 'Scrolling stays confined to the transcript');
    observations.narrow = narrow; await frame('narrow-reading-history.png');
    await bottomButton().focus(); await bottomButton().press('Enter'); await until(atBottom, 'keyboard can scroll narrow layout to bottom');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
    await until(() => page.evaluate(() => innerWidth === 1400), 'resize pinned viewport back to wide');
    await until(atBottom, 'pinned reader remains at bottom when viewport and text reflow');
    assert.equal(await bottomButton().count(), 0);
    checks.push('The control works at narrow width and by keyboard without scrolling outer containers; a pinned viewport resize stays at bottom');

    const isolation = await app.evaluate(() => ({ blocked: globalThis.__scrollFixture.blocked, nativeCalls: globalThis.__keychainFixture.nativeCalls, credentialCalls: globalThis.__keychainFixture.credentialCalls }));
    assert.deepEqual(isolation.blocked, []); assert.equal(isolation.nativeCalls, 0); assert.equal(isolation.credentialCalls, 0); assert.deepEqual(errors, []);
    const runtime = await app.evaluate(({ app }, expected) => ({ app: app.getAppPath(), executable: app.getPath('exe'), dataDirectoryVerified: app.getPath('userData') === expected }), data);
    const result = { passed: true, kind, startedAt, completedAt: new Date().toISOString(), runtime, checks, frames, geometry, observations, isolation, errors, personalData: false, realModel: false, realCredentials: false, scriptSha256: createHash('sha256').update(await fs.readFile(__filename)).digest('hex') };
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page) await frame('failure.png').catch(() => {});
    if (page) observations.probe = await page.evaluate(() => window.__scrollProbe).catch(() => undefined);
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, frames, observations, errors }, null, 2)); throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.rm(data, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
