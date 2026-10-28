const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'weather-' + kind), output = path.join(root, 'output', 'playwright', 'weather-' + kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const add = offset => new Date(Date.parse(today + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  const checks = [], errors = [], illustrations = []; let app, page, versions, executable;
  async function launch(fixture = {}) {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'packaged' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true, ...fixture });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor();
  }
  async function ready(city, date = today, temperature) {
    await page.locator(`.weather-block[data-weather-date="${date}"][data-weather-state="ready"]`).waitFor();
    assert.equal(await page.locator('.weather-city').textContent(), city);
    if (temperature) assert.equal(await page.locator('.weather-temperature').textContent(), temperature);
  }
  async function control(value) { await app.evaluate((_, value) => Object.assign(globalThis.__weatherFixture, value), value); }
  async function settings() { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('tab', { name: '天气', exact: true }).click(); await page.getByRole('search', { name: '天气城市搜索' }).waitFor(); }
  async function search(name) { await page.getByRole('textbox', { name: '天气城市', exact: true }).fill(name); await page.getByRole('button', { name: '搜索天气城市', exact: true }).click(); }
  async function select(name, region) { await search(name); await page.getByRole('button', { name: `使用天气城市 ${name} · ${region} · 中国`, exact: true }).click(); await page.locator('.weather-saved').waitFor(); }
  async function home() { await page.getByRole('button', { name: 'Home', exact: true }).click(); }
  // Seed fixture data through the existing service, then reload the renderer to display it.
  // This is test setup, not a weather refresh control in the UI.
  async function seedForecast(controlValue) {
    await settings(); await control({ forecastQueue: [controlValue] });
    await page.evaluate(async date => {
      const preference = JSON.parse(localStorage.getItem('workday.weather'));
      const result = await window.workday.call('weather.query', { date, location: preference?.mode === 'manual' ? preference.location : null, refresh: true });
      if (!result.ok) throw Error(result.error.message);
    }, today);
    await page.reload(); await home();
  }
  async function wait(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
  async function noArtwork() { assert.equal(await page.locator('.weather-art').count(), 0); }
  async function noWeather() {
    await page.locator('.day-panel .weather-block').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.day-panel .weather-city,.day-panel .weather-condition,.day-panel .weather-temperature,.day-panel .weather-message').count(), 0);
    await noArtwork();
  }
  async function todayUnavailable() {
    await page.locator('.tagline-readout[aria-label*="今日天气暂不可用"]').waitFor();
    await noWeather();
  }
  async function artwork(expected) {
    const picture = page.locator(`.weather-art[data-weather-art="${expected}"]`);
    await picture.waitFor();
    await picture.evaluate(async img => { await img.decode(); });
    const resource = await picture.evaluate(img => {
      return { src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0 && img.naturalHeight > 0, decorative: img.alt === '' && img.getAttribute('aria-hidden') === 'true' };
    });
    const source = new URL(resource.src);
    let svg;
    if (source.protocol === 'data:') {
      const comma = resource.src.indexOf(','), metadata = resource.src.slice(0, comma), payload = resource.src.slice(comma + 1);
      assert.match(metadata, /^data:image\/svg\+xml(?:;|$)/, `${expected} data resource must be SVG`);
      svg = /;base64(?:;|$)/.test(metadata) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
    } else {
      assert.equal(source.protocol, 'file:', 'weather smoke only reads packaged local SVG resources');
      svg = await fs.readFile(fileURLToPath(source), 'utf8');
    }
    assert.equal(resource.loaded, true, `${expected} artwork must decode`);
    assert.match(svg, /<svg\b/, `${expected} resource must be SVG`);
    assert.equal(resource.decorative, true, 'the existing weather label supplies accessible text');
    if (!resource.src.startsWith('data:')) assert.match(new URL(resource.src).pathname, new RegExp(`/${expected}(?:-[^/]+)?\\.svg$`));
    return resource.src;
  }
  try {
    await launch(); versions = await app.evaluate(() => ({ ...process.versions })); executable = await app.evaluate(() => process.execPath);
    await ready('出口城市', today, '16–25℃'); assert.equal(await page.locator('.weather-condition').textContent(), '阴');
    await artwork('overcast');
    assert.ok(await app.evaluate(() => globalThis.__weatherFixture.ipCalls >= 1));
    assert.equal(await page.locator('.day-panel progress,.day-panel .progress-label').count(), 0);
    assert.equal(await page.locator('.day-panel').getByRole('button', { name: '新增待办', exact: true }).count(), 1);
    assert.equal(await page.locator('.calendar').getByRole('button', { name: '新增待办', exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.day-panel').textContent(), /已完成\d+\/\d+/);
    assert.equal(await page.getByRole('button', { name: '新增待办', exact: true }).count(), 1);
    assert.equal(await page.locator('.weather-block button').count(), 0);
    checks.push('automatic location and selected-date Celsius range; weather action buttons, counts and progress absent; one inline-create action remains below the task list');

    await page.locator(`.day[aria-label^="${add(1)}"]`).click(); await ready('出口城市', add(1), '17–26℃');
    await page.locator(`.day[aria-label^="${today}"]`).click(); await ready('出口城市', today, '16–25℃');
    checks.push('calendar selection displays weather for the selected date');

    await settings(); await select('北京', '北京市'); await home(); await ready('北京', today, '2–11℃');
    checks.push('global Settings → Weather changes the displayed city');
    await settings(); await control({ searchDelays: { '旧城': 650 } }); await search('旧城'); await search('杭州');
    await page.getByRole('button', { name: '使用天气城市 杭州 · 浙江省 · 中国', exact: true }).waitFor(); await wait(750);
    assert.equal(await page.locator('.weather-candidate').count(), 2); assert.equal(await page.getByRole('button', { name: /使用天气城市 旧城/ }).count(), 0);
    await page.getByRole('button', { name: '使用天气城市 杭州 · 浙江省 · 中国', exact: true }).click(); await page.locator('.weather-saved').waitFor();
    checks.push('new city search wins delayed older search, with region/country candidates');

    const oldPreference = await page.evaluate(() => localStorage.getItem('workday.weather'));
    await page.evaluate(() => { globalThis.__originalWeatherWrite = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'workday.weather') throw new Error('quota'); return globalThis.__originalWeatherWrite.call(this, key, value); }; });
    await search('北京'); await page.getByRole('button', { name: '使用天气城市 北京 · 北京市 · 中国', exact: true }).click();
    await page.getByRole('alert').getByText('原设置保留', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('workday.weather')), oldPreference); assert.match(await page.locator('.weather-current').textContent(), /杭州/);
    await page.evaluate(() => { Storage.prototype.setItem = globalThis.__originalWeatherWrite; delete globalThis.__originalWeatherWrite; });
    await home(); await ready('杭州', today, '16–25℃'); await app.close(); app = null; await launch(); await ready('杭州', today, '16–25℃');
    assert.equal(await app.evaluate(() => globalThis.__weatherFixture.ipCalls), 0);
    checks.push('quota failure preserves old displayed/stored city; actual Electron restart persists manual city without IP request');

    await app.close(); app = null; await launch({ forecastQueue: [{ delay: 1000 }] });
    await noWeather();
    await ready('杭州', today, '16–25℃');
    await app.close(); app = null; await launch({ forecastQueue: [{ error: true }] });
    await todayUnavailable();
    await page.reload(); await ready('杭州', today, '16–25℃');
    await seedForecast({ nullOffset: 0 }); await todayUnavailable();
    await seedForecast({ code: 4 }); await ready('杭州', today, '16–25℃'); assert.equal(await page.locator('.weather-condition').textContent(), '未知天气');
    await noArtwork();
    await seedForecast({ code: 97 }); await ready('杭州', today, '16–25℃'); assert.equal(await page.locator('.weather-condition').textContent(), '强雷暴');
    await artwork('thunderstorm');
    await page.getByRole('button', { name: '上个月', exact: true }).click(); await page.locator('.month-grid .day:not(.outside)').first().click();
    await noWeather();
    await page.getByRole('button', { name: '今天', exact: true }).click(); await ready('杭州', today, '16–25℃');
    checks.push('loading, failed, null and out-of-range forecasts leave the day-panel corner empty; valid data returns after reload; unknown conditions hide artwork and WMO 97 shows thunderstorm');

    await settings(); await page.getByRole('button', { name: '恢复 IP 自动定位', exact: true }).click(); await home(); await ready('出口城市', today, '16–25℃');
    await app.close(); app = null; await launch({ ipFail: true });
    await todayUnavailable();
    await settings(); await select('北京', '北京市'); await home(); await ready('北京', today, '2–11℃');
    await control({ ipFail: false }); await settings(); await page.getByRole('button', { name: '恢复 IP 自动定位', exact: true }).click(); await home(); await ready('出口城市', today, '16–25℃');
    checks.push('failed startup IP location can use global settings for manual fallback and restore automatic location');

    await page.getByRole('button', { name: '新增待办', exact: true }).click();
    const draft = page.getByRole('textbox', { name: '新增待办内容', exact: true });
    await draft.fill('天气回归待办');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await draft.press('Enter'); await draft.waitFor({ state: 'detached' });
    await page.getByRole('checkbox', { name: '完成 天气回归待办', exact: true }).click(); await page.waitForFunction(() => document.querySelector('input[aria-label="完成 天气回归待办"]').checked);
    await page.getByRole('checkbox', { name: '完成 天气回归待办', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('input[aria-label="完成 天气回归待办"]').checked);
    await page.getByRole('button', { name: '编辑与改期 天气回归待办', exact: true }).focus(); await page.keyboard.press('Enter'); const dialog = page.getByRole('dialog', { name: '编辑待办' });
    await dialog.getByLabel('内容', { exact: true }).fill('编辑天气待办'); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '删除 编辑天气待办', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('checkbox', { name: '完成 编辑天气待办', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.day-panel .undo').count(), 0);
    assert.equal(await page.locator('.day-panel').getByRole('button', { name: '撤销', exact: true }).count(), 0);
    assert.doesNotMatch(await page.locator('.day-panel').textContent(), /待办已更新/);
    checks.push('retained task create, complete, reopen, edit and delete controls; deleted task and update/undo bar are absent');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
    await page.waitForFunction(() => innerWidth === 1500);
    const artSources = new Set();
    for (const [code, illustration] of [[0, 'clear'], [2, 'partly-cloudy'], [3, 'overcast'], [45, 'fog'], [53, 'drizzle'], [63, 'rain'], [73, 'snow'], [67, 'sleet'], [95, 'thunderstorm']]) {
      await seedForecast({ code }); await ready('出口城市', today, '16–25℃');
      artSources.add(await artwork(illustration));
      const screenshot = `art-${illustration}.png`;
      await page.locator('.day-panel').screenshot({ path: path.join(output, screenshot), animations: 'disabled' });
      illustrations.push({ code, illustration, screenshot });
    }
    assert.equal(artSources.size, 9, 'each weather family must load its own illustration');
    checks.push('all nine weather families load distinct SVG resources, decode to visible images, and have day-panel screenshots');
    await seedForecast({ code: 3, minBase: -16.9 }); await ready('出口城市', today, '-16.9–-7.9℃');
    await artwork('overcast');

    for (const [theme, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('tab', { name: '主题', exact: true }).click(); await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme); await home(); await ready('出口城市');
      for (const width of [1500, 760, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const placement = await page.locator('.day-panel .day-heading').evaluate(el => { const date = el.querySelector('.day-date').getBoundingClientRect(), weather = el.querySelector('.weather-block').getBoundingClientRect(), panel = el.getBoundingClientRect(); return weather.left >= date.right && weather.right <= panel.right + 1 && weather.width > 45; }); assert.equal(placement, true);
        await artwork('overcast');
        const imagePlacement = await page.locator('.weather-block').evaluate(el => {
          const image = el.querySelector('.weather-art').getBoundingClientRect(), block = el.getBoundingClientRect(), panel = el.closest('.day-panel').getBoundingClientRect();
          const rightGap = panel.right - image.right, style = getComputedStyle(el.querySelector('.weather-art'));
          return image.width === 64 && image.height === 64 && block.height <= 56 && image.left >= block.left && rightGap >= 1 && rightGap <= 8 && image.top >= panel.top && image.bottom <= panel.bottom && Math.abs((image.top + image.bottom - block.top - block.bottom) / 2) <= 1 && style.objectFit === 'contain';
        }); assert.equal(imagePlacement, true, `${theme}/${width} small artwork must stay centered behind the text near the card's right edge without cover scaling`);
        await page.locator('.weather-block').scrollIntoViewIfNeeded();
        const textPlacement = await page.locator('.weather-block').evaluate(el => {
          const image = getComputedStyle(el.querySelector('.weather-art')), copy = getComputedStyle(el.querySelector('.weather-copy'));
          const text = [...el.querySelectorAll('.weather-city,.weather-condition,.weather-temperature')];
          return {
            complete: text.length === 3 && text.every(node => node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().height > 0),
            foreground: Number(copy.zIndex) > Number(image.zIndex),
            unobstructed: text.every(node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }),
            decorative: image.position === 'absolute' && image.pointerEvents === 'none' && Number(image.opacity) > 0 && Number(image.opacity) < 1,
          };
        });
        assert.deepEqual(textPlacement, { complete: true, foreground: true, unobstructed: true, decorative: true }, `${theme}/${width} city, condition and negative decimal temperature must remain complete above the decorative weather backdrop`);
        await page.mouse.move(0, 0); await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        await page.locator('.day-panel').screenshot({ path: path.join(output, `art-theme-${theme}-${width}.png`), animations: 'disabled' });
        await seedForecast({ code: 0, minBase: -16.9 }); await ready('出口城市', today, '-16.9–-7.9℃'); await artwork('clear');
        await page.locator('.day-panel').screenshot({ path: path.join(output, `art-theme-${theme}-${width}-clear.png`), animations: 'disabled' });
        await seedForecast({ code: 3, minBase: -16.9 }); await ready('出口城市', today, '-16.9–-7.9℃');
      }
    }
    const titlebar = await page.locator('.titlebar').evaluate(el => ({ height: el.getBoundingClientRect().height, left: getComputedStyle(el).paddingLeft }));
    assert.equal(titlebar.height, 49); assert.equal(titlebar.left, '88px');
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => ({ min: BrowserWindow.getAllWindows()[0].getMinimumSize()[0], traffic: BrowserWindow.getAllWindows()[0].getWindowButtonPosition() })), { min: 660, traffic: { x: 12, y: 17 } });
    checks.push('three themes at 1500/760/660 pixels, local weather backdrop contained right of date with unobstructed foreground text, no horizontal overflow, compact titlebar and native traffic lights');
    assert.deepEqual(errors, []);
    const fixture = await app.evaluate(() => ({ installedBeforeEntry: globalThis.__weatherFixture.installedBeforeEntry, ipCalls: globalThis.__weatherFixture.ipCalls, forecastCalls: globalThis.__weatherFixture.forecastCalls, searchCalls: globalThis.__weatherFixture.searchCalls }));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, illustrations, kind, versions, executable, realElectron: true, provider: 'explicit test fixtures installed before main entry; not actual network', fixture, dataDirectory: data, personalData: false, titlebar }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks, output }, null, 2));
  } catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
