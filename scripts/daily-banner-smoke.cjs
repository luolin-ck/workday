const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = await fs.mkdtemp(path.join(root, 'test-data', 'daily-banner-'));
  const output = path.join(root, 'output', 'playwright', 'daily-banner', kind);
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'result.json'), { force: true });
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  const env = { ...process.env, WORKDAY_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const start = new Date(); start.setHours(12, 0, 0, 0);
  const date = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = date(start), tomorrow = date(new Date(start.getTime() + 86400000)), yesterday = date(new Date(start.getTime() - 86400000));
  let app, page; const checks = [], errors = [];
  async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out waiting for banner update'); }
  const current = () => page.locator('.tagline-current').textContent();
  const summary = () => page.locator('.tagline-readout').getAttribute('aria-label');
  const call = (op, input) => page.evaluate(async ({op,input}) => { const r = await window.workday.call(op,input); if (!r.ok) throw Error(r.error.message); return r.value; }, {op,input});
  try {
    app = await launchWithWeatherFixture(_electron, { executablePath: process.env.WORKDAY_ELECTRON_EXECUTABLE || require('electron'), args: kind === 'source' ? [root] : [], env }, { mockHolidays: true });
    page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.clock.install({ time: start }); await page.clock.pauseAt(new Date(start.getTime() + 1000));
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.reload();
    await page.locator('.tagline-current').waitFor(); await page.mouse.move(600, 500);
    await until(async () => (await current()).includes('出口城市今日 · 阴 16–25℃'));
    assert.equal(await app.evaluate(() => globalThis.__weatherFixture.forecastCalls), 1);
    const project = await call('projects.save', { name:'翻牌测试项目', description:'', directory:data });
    const task = await call('tasks.save', {title:'今日未完成',notes:'',date:today,projectId:null,completed:false});
    await call('tasks.save', {title:'跨项目待办',notes:'',date:today,projectId:project.id,completed:false});
    await call('tasks.save', {title:'已完成',notes:'',date:today,projectId:null,completed:true});
    const deleted = await call('tasks.save', {title:'已删除',notes:'',date:today,projectId:null,completed:false});
    await call('tasks.delete', {id:deleted.id,expectedVersion:deleted.version});
    const rolled = await call('tasks.save', {title:'昨天未完成',notes:'',date:yesterday,projectId:null,completed:false});
    assert.equal(rolled.date, today, 'past pending task is included in today');
    await call('tasks.save', {title:'明天待办',notes:'',date:tomorrow,projectId:null,completed:false});
    await until(async () => (await summary()).includes('今日还有 3 项待办'));
    await page.clock.runFor(6150);
    assert.match(await current(), /今日还有 3 项待办/);
    assert.notEqual(await page.locator('.tagline-out').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.screenshot({path:path.join(output,'mid-flip.png')});
    await page.clock.runFor(650);
    await page.getByRole('checkbox', {name:'完成 今日未完成',exact:true}).click();
    await until(async () => (await current()).includes('今日还有 2 项待办'));
    await page.clock.runFor(6000); assert.match(await current(), /专注今天/);
    await page.clock.runFor(18000); assert.match(await current(), /一件一件来/);
    checks.push('weather → live remaining tasks → rotating encouragements; deleted/completed/future dates excluded; project and rolled-over tasks included; 3D transform verified');
    assert.equal(await page.locator('.tagline button').count(), 0, 'overview has no pause/resume controls');
    await page.locator('.tagline').hover(); const hovered = await current();
    await page.clock.runFor(6500); const next = await current(); assert.notEqual(next, hovered);
    await page.clock.runFor(6000); assert.notEqual(await current(), next); await page.mouse.move(600,500);
    checks.push('no pause/resume controls; automatic rotation continues across two intervals while hovered');
    await page.locator(`.day[aria-label^="${yesterday}"]`).click();
    assert.match(await summary(), /今日还有 2 项待办/); assert.match(await summary(), /16–25℃/);
    await page.getByRole('button', {name:'设置',exact:true}).click();
    await page.getByRole('tab', {name:'天气',exact:true}).click();
    await page.getByRole('textbox', {name:'天气城市',exact:true}).fill('北京');
    await page.getByRole('button', {name:'搜索天气城市',exact:true}).click();
    await page.getByRole('button', {name:'使用天气城市 北京 · 北京市 · 中国',exact:true}).click();
    await until(async () => (await summary()).includes('北京今日 · 阴 2–11℃'));
    checks.push('calendar selection never changes today; manual city updates banner outside Home');
    await page.emulateMedia({ reducedMotion:'reduce' });
    await until(async () => await page.locator('.tagline-flip').count() === 0);
    assert.equal(await page.locator('.tagline-toggle').count(),0);
    const staticText = await page.locator('.tagline-readout').textContent(); await page.clock.runFor(12000);
    assert.equal(await page.locator('.tagline-readout').textContent(),staticText);
    await page.clock.fastForward(12*60*60*1000);
    await until(async () => (await summary()).startsWith(tomorrow));
    assert.match(await summary(), /今日还有 1 项待办/);
    checks.push('reduced motion is static; renderer-only clock advances banner date at midnight (service rollover is covered separately)');
    await page.getByRole('button',{name:'Home',exact:true}).click();
    await page.emulateMedia({ reducedMotion:'no-preference' });
    for (const [theme,label] of [['custom','自定义'],['mono','黑白'],['blue','蓝白']]) {
      await page.getByRole('button',{name:'设置',exact:true}).click(); await page.getByRole('tab',{name:'主题',exact:true}).click();
      await page.getByRole('button',{name:label,exact:true}).click(); await page.getByRole('button',{name:'Home',exact:true}).click();
      await until(() => page.evaluate(theme => document.documentElement.dataset.theme === theme, theme));
      for (const width of [1500,660]) {
        await app.evaluate(({BrowserWindow},width) => BrowserWindow.getAllWindows()[0].setSize(width,850),width);
        await until(() => page.evaluate(width => innerWidth === width,width));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
        assert.equal(await page.locator('.titlebar').evaluate(el => el.getBoundingClientRect().height),49);
        await page.screenshot({path:path.join(output,`${theme}-${width}.png`),animations:'disabled'});
      }
    }
    await app.evaluate(() => {globalThis.__weatherFixture.forecastQueue.push({error:true});});
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('tab',{name:'天气',exact:true}).click();
    await page.getByRole('textbox',{name:'天气城市',exact:true}).fill('失败城市'); await page.getByRole('button',{name:'搜索天气城市',exact:true}).click();
    await page.getByRole('button',{name:'使用天气城市 失败城市 · 浙江省 · 中国',exact:true}).click();
    await until(async () => (await summary()).includes('今日天气暂不可用'));
    checks.push('three themes at wide/narrow sizes, no overflow, weather failure fallback');
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,kind,checks,dataDirectory:data},null,2));
    console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
  } catch (error) { if (page && !page.isClosed()) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{}); throw error; }
  finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
