const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'solar-term-' + kind), output = path.join(root, 'output', 'playwright', 'solar-term', kind);
  await fs.rm(data, { recursive: true, force: true }); await fs.mkdir(data, { recursive: true }); await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = []; let app, page;
  const day = date => page.locator(`.day[aria-label^="${date}"]`);
  async function month(year, month) {
    const current = (await page.locator('.calendar h1').textContent()).match(/(\d+)年(\d+)月/);
    const offset = (year - Number(current[1])) * 12 + month - Number(current[2]);
    for (let i = 0; i < Math.abs(offset); i++) await page.getByRole('button', { name: offset > 0 ? '下个月' : '上个月', exact: true }).click();
  }
  async function term(date, name) {
    assert.equal(await day(date).locator('.lunar-date.solar-term').textContent(), name);
    assert.match(await day(date).getAttribute('title'), new RegExp(`农历.+${name}`));
    assert.match(await day(date).getAttribute('aria-label'), new RegExp(`农历.+${name}`));
  }
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'packaged' ? [] : [root], env, timeout: 30000 }, { mockHolidays: true });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('navigation', { name: '全局导航' }).waitFor(); await month(2026, 10);
    await term('2026-10-08', '寒露'); await term('2026-10-23', '霜降');
    assert.equal(await day('2026-10-13').locator('.lunar-date').textContent(), '初四');
    assert.equal(await day('2026-10-13').locator('.solar-term').count(), 0);
    checks.push('October solar terms replace lunar labels only on their date, with full lunar text retained in title and aria');
    await month(2026, 11); await term('2026-11-07', '立冬'); await term('2026-11-22', '小雪');
    assert.doesNotMatch(await page.locator('.workspace.home').textContent(), /逾期|AI 对话|从一个问题开始/);
    assert.equal(await page.getByRole('region', { name: '新聊天', exact: true }).count(), 1);
    assert.equal(await page.getByRole('combobox', { name: '所属项目', exact: true }).inputValue(), '不在项目中');
    checks.push('November terms are present and the compact optional-project Home composer remains intact');
    for (const [theme, label] of [['custom', '自定义'], ['mono', '黑白'], ['blue', '蓝白']]) {
      await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('tab', { name: '主题', exact: true }).click();
      await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('button', { name: 'Home', exact: true }).click();
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme); await month(2026, 11);
      for (const width of [1500, 660]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 980), width);
        await page.waitForFunction(width => innerWidth === width, width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        for (const [date, name] of [['2026-11-07', '立冬'], ['2026-11-22', '小雪']]) {
          await term(date, name); const cell = await day(date).boundingBox(), text = await day(date).locator('.solar-term').boundingBox();
          assert.ok(text.width > 0 && text.x >= cell.x && text.x + text.width <= cell.x + cell.width && text.y + text.height <= cell.y + cell.height);
        }
        await page.locator('.calendar').scrollIntoViewIfNeeded(); await page.mouse.move(0, 0);
        await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        checks.push(`${theme} theme at ${width}px shows terms inside their cells without page overflow`);
      }
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, kind, realElectron: true, executable: await app.evaluate(() => process.execPath), checks, dataDirectory: data, weatherAndHolidays: 'fixtures installed before main entry', personalData: false, modelRequests: 0 }, null, 2));
    console.log(JSON.stringify({ passed: true, kind, checks: checks.length, output }));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
