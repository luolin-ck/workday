const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
const { Store } = require('../dist/main/store.js');

async function main() {
  const root = path.resolve(__dirname, '..'), kind = process.env.WORKDAY_ELECTRON_EXECUTABLE ? 'packaged' : 'source';
  const data = path.join(root, 'test-data', 'calendar-schedules-' + kind), output = path.join(root, 'output/playwright/calendar-schedules', kind);
  await fs.rm(data, { recursive:true, force:true }); await fs.mkdir(data, { recursive:true }); await fs.mkdir(output, { recursive:true });
  await fs.rm(path.join(output, 'result.json'), { force:true });
  const context = { date:null, taskIds:[], knowledgeRefs:[], skillRef:null, mcpRefs:[] };
  const historyId = randomUUID(), model = { sourceId:randomUUID(), modelId:'fixture' };
  const store = await Store.open(path.join(data, 'workday.sqlite'));
  await store.transaction(() => {
    store.put('schedules', { id:historyId, version:1, name:'过去实际执行', prompt:'fixture', createdAt:'2026-09-01T00:00:00Z', updatedAt:'2026-09-01T00:00:00Z', projectId:null, model, context, spec:{ kind:'daily', time:'09:00', timezone:'Asia/Shanghai' }, enabled:false, status:'paused', pauseReason:'fixture', nextRunAt:null, nextSlot:null, sourceVersion:1 });
    store.put('runs', { id:randomUUID(), scheduleId:historyId, triggerType:'auto', triggerId:null, scheduledFor:'2026-10-01T01:00:00Z', startedAt:'2026-10-01T01:00:00Z', endedAt:'2026-10-01T01:00:01Z', status:'success', conversationId:null, error:null, model });
  }); store.close();
  await fs.mkdir(path.join(data, 'holidays'), { recursive:true });
  // Synthetic 2027 layout fixture, reusing the validated cache shape; not a claimed official 2027 calendar.
  const holidayNames=['元旦','春节','清明节','劳动节','端午节','中秋节','国庆节'];
  await fs.writeFile(path.join(data, 'holidays/2027.json'), JSON.stringify({ parserVersion:1, year:2027, sourceUrl:'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm', sourceTitle:'国务院办公厅关于2027年部分节假日安排的通知', queriedAt:new Date().toISOString(), days:holidayNames.map((name,i)=>({ date:i===3?'2027-05-01':`2027-01-0${i+1}`,name,kind:'rest' })) }));
  const env = { ...process.env, WORKDAY_DATA_DIR:data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], measurements = [], errors = []; let app, page;
  const call = (op, input) => page.evaluate(async ({op,input}) => { const r=await window.workday.call(op,input); if(!r.ok)throw new Error(r.error.message);return r.value; }, {op,input});
  const nav = name => page.getByRole('navigation', {name:'全局导航'}).getByRole('button', {name,exact:true});
  const cell = date => page.locator(`.day[aria-label^="${date}"]`);
  const refresh = async () => { await page.getByRole('button', {name:'刷新日历',exact:true}).click(); await page.getByRole('button', {name:'刷新日历',exact:true}).click({trial:true}); };
  async function month(year, number) {
    const current = (await page.locator('.calendar h1').textContent()).match(/(\d+)年(\d+)月/), offset=(year-Number(current[1]))*12+number-Number(current[2]);
    for(let i=0;i<Math.abs(offset);i++)await page.getByRole('button',{name:offset>0?'下个月':'上个月',exact:true}).click();
    await page.getByRole('button',{name:'刷新日历',exact:true}).click({trial:true});
  }
  try {
    app = await launchWithWeatherFixture(_electron, { ...(process.env.WORKDAY_ELECTRON_EXECUTABLE ? {executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE} : {args:[root]}), env }, {mockHolidays:true});
    page = await app.firstWindow(); page.on('pageerror', error=>errors.push(error.message));
    await nav('Home').waitFor();
    await app.evaluate(({net}) => { const original=net.fetch;globalThis.__unexpectedRequests=[];net.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input.url??input.href);if(!['ipwho.is','geocoding-api.open-meteo.com','api.open-meteo.com','sousuo.www.gov.cn'].includes(url.hostname)){globalThis.__unexpectedRequests.push(url.hostname);throw new Error('No external/model requests in schedule fixture');}return original(input,init);}; });
    assert.equal(await nav('定时任务').locator('.lucide-alarm-clock').count(),1);
    const source=await call('sources.save',{name:'隔离模型',baseUrl:'https://fixture.invalid/v1',models:[{id:'fixture',name:'fixture',supportsTools:false}]});
    const binding={sourceId:source.id,modelId:'fixture'};await call('settings.defaultModel',{model:binding});await page.reload();await nav('定时任务').click();
    await page.getByRole('button',{name:'创建计划',exact:true}).click();
    let dialog=page.getByRole('dialog');await dialog.getByLabel('计划名称',{exact:true}).fill('双周报');await dialog.getByLabel('执行频率',{exact:true}).selectOption('biweekly');
    await dialog.getByLabel('首次执行日期',{exact:true}).fill('2026-12-25');await dialog.getByLabel('当地执行时间',{exact:true}).fill('09:00');await dialog.getByLabel('IANA 时区',{exact:true}).fill('Asia/Shanghai');await dialog.getByLabel('提示词',{exact:true}).fill('isolated fixture, never execute');
    await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
    const card=page.locator('.entry-card').filter({has:page.getByRole('heading',{name:'双周报',exact:true})});
    assert.match(await card.textContent(),/每两周 · 自 2026-12-25/);assert.match(await card.textContent(),/已暂停/);
    await card.getByRole('button',{name:'编辑绑定',exact:true}).click();dialog=page.getByRole('dialog');assert.equal(await dialog.getByLabel('首次执行日期',{exact:true}).inputValue(),'2026-12-25');assert.equal(await dialog.getByLabel('执行频率',{exact:true}).inputValue(),'biweekly');
    await dialog.getByLabel('当地执行时间',{exact:true}).fill('09:30');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await nav('Home').click();await month(2026,12);assert.equal(await page.locator('.schedule-count').count(),0,'saved schedules stay paused');
    await nav('定时任务').click();await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByRole('button',{name:'暂停',exact:true}).waitFor();await nav('Home').click();await month(2026,12);
    assert.equal(await cell('2026-12-25').locator('.schedule-count').textContent(),'1');assert.equal(await cell('2027-01-08').locator('.schedule-count').textContent(),'1');assert.equal(await cell('2027-01-01').locator('.schedule-count').count(),0);
    const alarmBottom=await cell('2026-12-25').evaluate(el=>{const style=getComputedStyle(el);return el.getBoundingClientRect().bottom-el.querySelector('.schedule-count').getBoundingClientRect().bottom-parseFloat(style.paddingBottom)-parseFloat(style.borderBottomWidth);});assert.ok(Math.abs(alarmBottom)<=1,'alarm-only cells retain the same padded bottom');
    await cell('2026-12-25').locator('.schedule-count').hover();await page.getByRole('tooltip').filter({hasText:'双周报 09:30 · 待执行'}).waitFor();assert.equal(await page.getByRole('tooltip').count(),1);
    await page.mouse.move(0,0);await cell('2026-12-25').focus();await page.getByRole('tooltip').filter({hasText:'双周报 09:30 · 待执行'}).waitFor();await cell('2026-12-25').evaluate(el=>el.blur());
    await nav('定时任务').click();await card.getByRole('button',{name:'暂停',exact:true}).click();await card.getByRole('button',{name:'启用',exact:true}).waitFor();await nav('Home').click();await month(2026,12);assert.equal(await page.locator('.schedule-count').count(),0);
    await nav('定时任务').click();await card.getByRole('button',{name:'编辑绑定',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('首次执行日期',{exact:true}).fill('2027-01-01');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});await card.getByRole('button',{name:'启用',exact:true}).click();await card.getByRole('button',{name:'暂停',exact:true}).waitFor();await page.reload();await nav('Home').click();await month(2027,1);
    for(const date of ['2027-01-01','2027-01-15','2027-01-29'])assert.equal(await cell(date).locator('.schedule-count').textContent(),'1');
    assert.equal(await cell('2026-12-25').count(),0);assert.equal(await cell('2027-01-08').locator('.schedule-count').count(),0);
    checks.push('real editor creates/edits anchored biweekly schedules; save stays paused, enable/pause updates markers, cross-year cadence and edited anchor persist across reload, hover/keyboard tooltip is singular');
    await month(2026,10);await cell('2026-10-01').locator('.schedule-count').hover();await page.getByRole('tooltip').filter({hasText:'过去实际执行 09:00 · 已执行'}).waitFor();assert.equal(await cell('2026-10-02').locator('.schedule-count').count(),0);
    checks.push('paused schedule retains only actual automatic historical runs, labelled executed instead of future');
    for(const [name,spec] of [['月度汇总',{kind:'once',date:'2027-05-01',time:'09:00',timezone:'Asia/Shanghai'}],['双周检查',{kind:'biweekly',startDate:'2027-05-01',time:'10:00',timezone:'Asia/Shanghai'}]]){const s=await call('schedules.save',{name,prompt:'isolated fixture',projectId:null,model:binding,context,spec});await call('schedules.toggle',{id:s.id,expectedVersion:s.version,enabled:true});}
    for(const [title,dueDate,completed] of [['逾期待办','2026-10-01',false],['本日截止待办','2027-05-01',false],['完成记录',null,true]])await call('tasks.save',{title,notes:'',date:'2027-05-01',dueDate,projectId:null,completed});
    for(let i=0;i<8;i++)await call('tasks.save',{title:`两位计数夹具 ${i}`,notes:'',date:'2027-05-01',dueDate:null,projectId:null,completed:false});
    await month(2027,5);await refresh();
    for(const [width,height] of [[1500,980],[1100,620],[971,700],[660,620]]) {
      await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});await page.waitForFunction(width=>innerWidth===width,width);await cell('2027-05-01').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const target=cell('2027-05-01');assert.equal(await target.locator('.schedule-count').textContent(),'2');assert.equal(await target.locator('.schedule-count .lucide-alarm-clock').count(),1);assert.deepEqual(await target.locator('.day-tasks>span').allTextContents(),['10','1','1']);assert.equal(await target.locator('.deadline-mark').count(),1);assert.equal(await target.getAttribute('data-holiday'),'rest');
      const geometry=await target.evaluate(el=>{const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};const style=getComputedStyle(el);return {cell:rect(el),heading:rect(el.querySelector('.day-heading')),alarm:rect(el.querySelector('.schedule-count')),icon:rect(el.querySelector('.schedule-count svg')),summary:rect(el.querySelector('.day-summary')),counts:[...el.querySelectorAll('.day-tasks>span')].map(rect),padding:parseFloat(style.paddingBottom)+parseFloat(style.borderBottomWidth),overflow:document.documentElement.scrollWidth>innerWidth};});
      await fs.writeFile(path.join(output,`${width}-geometry.json`),JSON.stringify(geometry,null,2));
      assert.ok(!geometry.overflow,width+': no horizontal page overflow');assert.ok(geometry.heading.bottom<=geometry.alarm.top,width+': alarm row must not overlap lunar/date header');
      for(const count of geometry.counts)assert.ok(geometry.alarm.right<=count.left||count.right<=geometry.alarm.left||geometry.alarm.bottom<=count.top||count.bottom<=geometry.alarm.top,width+': alarm and task counts do not overlap');
      for(const item of [geometry.alarm,geometry.icon,...geometry.counts])assert.ok(item.width>0&&item.height>0&&item.left>=geometry.cell.left&&item.right<=geometry.cell.right&&item.top>=geometry.cell.top&&item.bottom<=geometry.cell.bottom,width+': all four icon counts are inside cell');
      for(const count of geometry.counts){assert.ok(Math.abs(count.top-geometry.counts[0].top)<=1,width+': original three counts remain on one row');assert.ok(Math.abs(geometry.cell.bottom-count.bottom-geometry.padding)<=1,width+': original counts retain bottom inset '+JSON.stringify(geometry));}
      await target.locator('.schedule-count').hover();await page.getByRole('tooltip').filter({hasText:'定时任务 2 项'}).filter({hasText:'月度汇总 09:00'}).filter({hasText:'双周检查 10:00'}).waitFor();assert.equal(await page.getByRole('tooltip').count(),1);
      await target.click();assert.equal(await target.getAttribute('aria-pressed'),'true');await page.mouse.move(0,0);await target.evaluate(el=>el.blur());await page.locator('.calendar').screenshot({path:path.join(output,`${width}x${height}-schedules.png`),animations:'disabled'});
      measurements.push({width,height,...geometry});checks.push(`${width}x${height}: 42 cells, holiday/deadline/date and alarm+count fit, three task counts stay bottom-aligned and one-line, aggregate tooltip and date selection work`);assert.equal(await page.locator('.month-grid .day').count(),42);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__unexpectedRequests),[]);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,kind,realElectron:true,executable:await app.evaluate(()=>process.execPath),checks,measurements,dataDirectory:data,personalData:false,modelRequests:0},null,2));
    console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
  } catch(error) {if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally {if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
