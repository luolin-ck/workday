const { setFixtureTheme } = require('./appearance-fixture.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');
const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');

async function main(){
 const root=path.resolve(__dirname,'..'),kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'packaged':'source';
 const data=path.join(root,'test-data','meetings-'+kind),output=path.join(root,'output/playwright/meetings',kind);
 await fs.rm(data,{recursive:true,force:true});await fs.mkdir(data,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.rm(path.join(output,'result.json'),{force:true});
 const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
 const checks=[],measurements=[],errors=[];let app,page;
 const meeting=(id,start,end,extra={})=>({id,title:'合成会议 '+id,start,end,allDay:false,startDate:null,endDate:null,...extra});
 const title='合成会议：用于验证单行省略和完整悬浮说明的非常长的会议标题';
 const fixtures=[meeting('timed','2026-10-15T09:00:00+08:00','2026-10-15T10:00:00+08:00',{title}),meeting('all-day','2026-10-14T16:00:00Z','2026-10-16T16:00:00Z',{allDay:true,startDate:'2026-10-15',endDate:'2026-10-17'})];
 const cell=date=>page.locator(`.day[aria-label^="${date}"]`);
 const nav=name=>page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name,exact:true});
 const control=value=>app.evaluate((_,value)=>Object.assign(globalThis.__meetingsFixture,value),value);
 const call=(op,input)=>page.evaluate(async({op,input})=>{const r=await window.workday.call(op,input);if(!r.ok)throw new Error(r.error.message);return r.value;},{op,input});
 const idle=()=>page.waitForFunction(()=>document.querySelector('.calendar-meetings-control')?.getAttribute('aria-busy')==='false');
 const sync=async()=>{await page.getByRole('button',{name:'刷新日历',exact:true}).click();await page.getByRole('button',{name:'刷新日历',exact:true}).click({trial:true});await idle();};
 async function month(year,number){const current=(await page.locator('.calendar h1').textContent()).match(/(\d+)年(\d+)月/),offset=(year-Number(current[1]))*12+number-Number(current[2]);for(let i=0;i<Math.abs(offset);i++)await page.getByRole('button',{name:offset>0?'下个月':'上个月',exact:true}).click();}
 try{
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='source'?[root]:[],env},{mockHolidays:true});
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await nav('Home').waitFor();
  await page.getByRole('button',{name:'连接钉钉日历',exact:true}).waitFor();
  assert.equal(await page.locator('.calendar-title').getByRole('button',{name:'连接钉钉日历',exact:true}).count(),1);
  assert.equal(await page.locator('.day-meetings').count(),0,'unconnected calendar must not show a meeting category');
  assert.equal(await app.evaluate(()=>globalThis.__meetingsFixture.installedBeforeEntry),true);
  assert.ok((await app.evaluate(()=>globalThis.__meetingsFixture.calls)).every(call=>!call.requestAccess));
  await control({status:'notDetermined',meetings:[],queued:[{status:'ready',meetings:fixtures,delayMs:400}]});await page.getByRole('button',{name:'连接钉钉日历',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'正在同步钉钉日历',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('.day-meetings').count(),0,'loading stays in the month header');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(550);
  assert.equal(await page.getByRole('button',{name:'连接钉钉日历',exact:true}).count(),0,'focus while granting must not replace the authorization result with a stale unapproved query');
  await control({status:'ready',meetings:fixtures});
  await idle();await month(2026,10);await sync();
  const requests=await app.evaluate(()=>globalThis.__meetingsFixture.calls);assert.equal(requests.filter(call=>call.requestAccess).length,1);assert.ok(requests.some(call=>call.startDate==='2026-09-27'&&call.endDate==='2026-11-08'));
  await cell('2026-10-15').click();assert.equal(await cell('2026-10-15').locator('.meeting-count').textContent(),'2');assert.equal(await cell('2026-10-16').locator('.meeting-count').textContent(),'1');assert.equal(await cell('2026-10-17').locator('.meeting-count').count(),0);
  assert.equal(await page.locator('.day-meetings .meeting-row').count(),2);assert.equal(await page.locator('.day-meetings input,.day-meetings button').count(),0);
  await page.locator('.meeting-title').filter({hasText:title}).hover();await page.getByRole('tooltip').filter({hasText:title}).waitFor();await page.mouse.move(0,0);
  checks.push('only explicit connect requests access; focus during grant preserves its result; 42-day range, independent meeting counts, all-day end exclusion, read-only single-line details and full tooltip');
  const priorSync=await app.evaluate(()=>globalThis.__meetingsFixture.calls.length);
  await page.locator('.calendar-title').getByRole('button',{name:'同步钉钉日历',exact:true}).click();await idle();
  assert.ok((await app.evaluate(()=>globalThis.__meetingsFixture.calls.length))>priorSync);
  assert.ok(!(await app.evaluate(()=>globalThis.__meetingsFixture.calls.at(-1))).requestAccess);
  checks.push('calendar connection and sync live in the month heading; loading disables the entry; ordinary sync never requests permission');

  await control({status:'notDetermined',meetings:[]});await sync();
  const november=[meeting('after-grant','2026-11-15T09:00:00+08:00','2026-11-15T10:00:00+08:00')];
  await control({status:'ready',meetings:november,queued:[{status:'ready',meetings:fixtures,delayMs:400}]});
  await page.getByRole('button',{name:'连接钉钉日历',exact:true}).click();await page.getByRole('button',{name:'下个月',exact:true}).click();
  await cell('2026-11-15').locator('.meeting-count').waitFor();assert.equal(await cell('2026-11-15').locator('.meeting-count').textContent(),'1');
  assert.equal((await app.evaluate(()=>globalThis.__meetingsFixture.calls.at(-1))).startDate,'2026-11-01');
  await control({meetings:fixtures});await page.getByRole('button',{name:'上个月',exact:true}).click();await cell('2026-10-15').locator('.meeting-count').waitFor();
  checks.push('month changes while awaiting authorization trigger a fresh query for the current visible range');

  await control({queued:[{status:'ready',meetings:[meeting('stale','2026-11-15T09:00:00+08:00','2026-11-15T10:00:00+08:00')],delayMs:400},{status:'ready',meetings:fixtures,delayMs:0}]});
  await page.getByRole('button',{name:'下个月',exact:true}).click();assert.equal(await page.locator('.meeting-count').count(),0,'new range immediately clears previous meetings');await page.getByRole('button',{name:'上个月',exact:true}).click();
  await cell('2026-10-15').locator('.meeting-count').waitFor();await page.waitForTimeout(500);assert.equal(await cell('2026-10-15').locator('.meeting-count').textContent(),'2');assert.equal(await page.getByText('合成会议 stale',{exact:true}).count(),0);
  await control({meetings:[]});await sync();assert.equal(await page.locator('.meeting-count,.meeting-row,.day-meetings').count(),0);
  assert.equal(await page.locator('.day-items .day-group-heading').textContent(),'事项0');
  await control({meetings:fixtures});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await cell('2026-10-15').locator('.meeting-count').waitFor();
  await control({status:'error'});await sync();assert.equal(await page.locator('.meeting-count,.meeting-row,.day-meetings').count(),0);
  const retry=page.locator('.calendar-title').getByRole('button',{name:'重试同步钉钉日历',exact:true});
  await retry.hover();await page.getByRole('tooltip').filter({hasText:'合成日历状态：error'}).waitFor();await page.mouse.move(0,0);
  await control({status:'denied'});await retry.click();await idle();assert.equal(await retry.getAttribute('data-state'),'denied');assert.equal(await page.locator('.day-meetings').count(),0);assert.ok(!(await app.evaluate(()=>globalThis.__meetingsFixture.calls.at(-1))).requestAccess);
  await control({status:'ready',meetings:fixtures});await nav('项目').click();await nav('Home').click();await cell('2026-10-15').locator('.meeting-count').waitFor();
  checks.push('stale response ignored after month changes; fresh deletion/error clears; focus and return Home refresh; denied retry never requests access');

  const source=await call('sources.save',{name:'合成模型',baseUrl:'https://fixture.invalid/v1',models:[{id:'fixture',name:'fixture',supportsTools:false}]});const model={sourceId:source.id,modelId:'fixture'};await call('settings.defaultModel',{model});
  for(let i=0;i<10;i++)await call('tasks.save',{title:'合成待办 '+i,notes:'',date:'2027-05-01',dueDate:i===0?'2026-01-01':i===1?'2027-05-01':null,projectId:null,completed:false});
  await call('tasks.save',{title:'合成完成',notes:'',date:'2027-05-01',dueDate:null,projectId:null,completed:true});
  await call('tasks.save',{title:'合成间距样例',notes:'',date:'2027-05-02',dueDate:null,projectId:null,completed:true});
  const schedule=await call('schedules.save',{name:'合成远期计划',prompt:'Synthetic fixture, never execute',projectId:null,model,context:{date:null,taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[]},spec:{kind:'once',date:'2027-05-01',time:'09:00',timezone:'Asia/Shanghai'}});await call('schedules.toggle',{id:schedule.id,expectedVersion:schedule.version,enabled:true});
  await control({meetings:[meeting('layout','2027-05-01T09:00:00+08:00','2027-05-01T10:00:00+08:00',{title}),meeting('spacing','2027-05-02T09:00:00+08:00','2027-05-02T10:00:00+08:00')]});
  const before=await call('state.get',{});assert.ok(!JSON.stringify(before).includes(title));
  await setFixtureTheme(page, 'mono');await nav('Home').waitFor();await month(2027,5);await cell('2027-05-01').click();await cell('2027-05-01').locator('.meeting-count').waitFor();
  for(const [width,height] of [[1500,980],[1100,620],[971,700],[660,620]]){
   await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setSize(width,height),{width,height});await page.waitForFunction(width=>innerWidth===width,width);await cell('2027-05-01').scrollIntoViewIfNeeded();
   await page.locator('.calendar').screenshot({path:path.join(output,`spacing-${width}.png`)});
   const refreshBounds=await page.getByRole('button',{name:'刷新日历',exact:true}).boundingBox(),syncBounds=await page.locator('.calendar-meetings-control').boundingBox();
   assert.ok(syncBounds.x>=refreshBounds.x+refreshBounds.width,`${width}: meeting sync sits right of refresh`);assert.equal(syncBounds.height,refreshBounds.height);assert.equal(syncBounds.y,refreshBounds.y);
   const simple=await cell('2027-05-02').evaluate(el=>[...el.querySelectorAll('.day-summary span')].map(node=>{const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,fontSize:getComputedStyle(node).fontSize,icon:node.querySelector('svg').getBoundingClientRect().width};}));
   assert.equal(simple.length,2);assert.equal(simple[0].top,simple[1].top,`${width}: meeting and completed counts should share one row`);assert.equal(simple[0].fontSize,simple[1].fontSize);assert.equal(simple[0].icon,simple[1].icon);
   const geometry=await cell('2027-05-01').evaluate(el=>{const rect=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};};return{cell:rect(el),heading:rect(el.querySelector('.day-heading')),events:rect(el.querySelector('.day-events')),counts:[...el.querySelectorAll('.day-summary span')].map(rect),tasks:rect(el.querySelector('.day-tasks')),overflow:document.documentElement.scrollWidth>innerWidth};});
   assert.ok(!geometry.overflow);assert.ok(geometry.counts.every(c=>c.top>=geometry.heading.bottom));assert.ok(geometry.events.right<=geometry.cell.right);assert.equal(await cell('2027-05-01').locator('.deadline-mark').count(),1);assert.equal(await cell('2027-05-01').locator('.schedule-count').textContent(),'1');assert.deepEqual(await cell('2027-05-01').locator('.day-tasks>span').allTextContents(),['10','1','1']);
   for(let i=0;i<geometry.counts.length;i++)for(let j=i+1;j<geometry.counts.length;j++){const a=geometry.counts[i],b=geometry.counts[j];assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,`${width}: count groups must not overlap`);}
   const inset=await cell('2027-05-01').evaluate(el=>({padding:parseFloat(getComputedStyle(el).paddingBottom),border:parseFloat(getComputedStyle(el).borderBottomWidth)}));
   assert.ok(Math.abs(geometry.cell.bottom-Math.max(...geometry.counts.map(c=>c.bottom))-inset.border-inset.padding)<1,`${width}: counts align to bottom padding`);
   assert.ok(geometry.counts.every(c=>c.left>=geometry.cell.left&&c.right<=geometry.cell.right&&c.bottom<=geometry.cell.bottom),`${width}: every icon count fits inside day cell ${JSON.stringify(geometry)}`);
   const details=await page.locator('.day-meetings').evaluate(el=>[...el.querySelectorAll('.meeting-title')].map(node=>({whiteSpace:getComputedStyle(node).whiteSpace,textOverflow:getComputedStyle(node).textOverflow})));
   assert.ok(details.every(d=>d.whiteSpace==='nowrap'&&d.textOverflow==='ellipsis'));
   const list=page.locator('.day-panel .task-list');await list.evaluate(el=>{el.scrollTop=0;});
   assert.deepEqual(await list.locator('.day-group-heading').allTextContents(),['会议1','事项11']);
   const groups=await list.evaluate(el=>{
    const headings=[...el.querySelectorAll('.day-group-heading')].map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return{left:r.left,height:r.height,font:s.fontSize,padding:s.padding};});
    const rows=[el.querySelector('.meeting-row'),el.querySelector('.task-row')].map(node=>node.getBoundingClientRect().height);
    const fonts=[el.querySelector('.meeting-title'),el.querySelector('.task-title input')].map(node=>getComputedStyle(node).fontSize);
    return{headings,rows,fonts};
   });
   assert.deepEqual(groups.headings[0],groups.headings[1],`${width}: category heading alignment and typography`);
   assert.equal(groups.rows[0],groups.rows[1],`${width}: common meeting and item row height`);assert.equal(groups.fonts[0],groups.fonts[1]);
   const fixed=()=>page.locator('.conversation-column').evaluate(el=>['.day-panel>.day-heading','.task-add','.composer'].map(selector=>{const r=el.querySelector(selector).getBoundingClientRect();return{top:r.top,bottom:r.bottom};}));
   const beforeScroll=await fixed();await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});assert.deepEqual(await fixed(),beforeScroll,`${width}: only grouped list scrolls`);
   await list.evaluate(el=>{el.scrollTop=0;});await page.locator('.day-panel').screenshot({path:path.join(output,`groups-${width}.png`)});
   measurements.push({width,height,...geometry,groups});
  }
  checks.push('four viewport widths preserve date/deadline, meeting row and bottom task counts without horizontal overflow; details ellipsize');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,980));await page.waitForFunction(()=>innerWidth===1500);
  await page.getByRole('button',{name:'新增待办',exact:true}).click();
  const draft=page.getByRole('textbox',{name:'新增待办内容',exact:true});await draft.waitFor();assert.equal(await draft.evaluate(el=>el===document.activeElement),true);
  const newBounds=await draft.boundingBox(),listBounds=await page.locator('.task-list').boundingBox();assert.ok(newBounds.y>=listBounds.y&&newBounds.y+newBounds.height<=listBounds.y+listBounds.height);
  await draft.fill('合成分组新增');await draft.press('Enter');await page.getByRole('textbox',{name:'待办内容 合成分组新增',exact:true}).waitFor();
  assert.equal(await page.locator('.day-items .day-group-heading').textContent(),'事项12');
  const edit=page.getByRole('textbox',{name:'待办内容 合成分组新增',exact:true});await edit.fill('合成分组失焦保存');await page.locator('.day-panel h2').click();await page.getByRole('textbox',{name:'待办内容 合成分组失焦保存',exact:true}).waitFor();
  const saved=(await call('state.get',{})).tasks.filter(t=>t.title==='合成分组失焦保存');assert.equal(saved.length,1);assert.equal(saved[0].date,'2027-05-01');
  checks.push('meeting/items categories align at four widths; row height and title type match; only list scrolls; inline add focuses and scrolls into view, Enter and blur persist one item');
  await control({meetings:fixtures});await month(2026,10);await cell('2026-10-15').click();await cell('2026-10-15').locator('.meeting-count').waitFor();
  await app.evaluate(({app})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),{AppService}=load('./dist/main/service.js'),original=AppService.prototype.call;globalThis.__meetingChatPayload=null;AppService.prototype.call=function(op,input){if(op==='chat.send'){globalThis.__meetingChatPayload=JSON.parse(JSON.stringify(input));throw new Error('Synthetic send stopped before model request');}return original.call(this,op,input);};});
  await page.locator('.composer textarea').fill('合成问题');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('alert').waitFor();
  const captured=await app.evaluate(()=>globalThis.__meetingChatPayload);assert.ok(captured);assert.ok(!JSON.stringify(captured).includes(title));assert.equal(captured.context.date,'2026-10-15');assert.equal(captured.context.calendarTasks,true);assert.ok(!('meetings'in captured.context));assert.ok(!JSON.stringify((await call('state.get',{})).conversations).includes(title));
  checks.push('actual Home send payload and saved conversation contain selected-day task context only, with no meeting data; model send blocked by fixture');
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'verified.png'),fullPage:true});await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,kind,checks,measurements,personalData:false,nativeCalendarQueries:0,modelRequests:0},null,2));console.log(JSON.stringify({passed:true,kind,checks:checks.length,output}));
 }catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
