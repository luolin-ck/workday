const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _electron } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const { launchWithWeatherFixture } = require('./electron-fixture-launch.cjs');
function png(width=1500,height=1500) {
  const crc = buffer => { let c=0xffffffff; for (const b of buffer) { c^=b; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk=(type,data)=>{ const t=Buffer.from(type), n=Buffer.alloc(4), c=Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t,data]))); return Buffer.concat([n,t,data,c]); };
  const header=Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height); let seed=1234567;
  for(let y=0;y<height;y++)for(let x=1;x<=width*3;x++){ seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[y*(width*3+1)+x]=seed&255; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function main() {
 const root=path.resolve(__dirname,'..'), kind=process.env.WORKDAY_ELECTRON_EXECUTABLE?'packaged':'source', red=process.env.WORKDAY_SMOKE_RED==='1';
 const data=path.join(root,'test-data','custom-theme-'+kind+(red?'-red':'')), output=path.join(root,'output/playwright','custom-theme-'+kind+(red?'-red':''));
 await fs.rm(data,{recursive:true,force:true});await fs.mkdir(data,{recursive:true});await fs.mkdir(output,{recursive:true});
 const env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;let app,page;const checks=[],errors=[];
 const launch=async()=>{ app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE||require('electron'),args:kind==='packaged'?[]:[root],env,timeout:30000},{mockHolidays:true});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('navigation',{name:'全局导航'}).waitFor();};
 const settings=async(waitReady=true)=>{await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'主题',exact:true}).click();if(!red&&waitReady)await page.waitForFunction(()=>document.querySelector('.appearance-settings')?.getAttribute('aria-busy')==='false');};
 const theme=async(id,name)=>{await page.getByRole('button',{name,exact:true}).click();await page.waitForFunction(id=>document.documentElement.dataset.theme===id,id);};
 const current=()=>page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('workday-appearance',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try {const value=await new Promise((resolve,reject)=>{const tx=db.transaction('appearance');const r=tx.objectStore('appearance').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return value?{...value,background:value.background?{size:value.background.size,type:value.background.type,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await value.background.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('')}:null}:null;}finally{db.close();}});
 const upload=async(name,mimeType,buffer)=>page.getByLabel('上传背景图片',{exact:true}).setInputFiles({name,mimeType,buffer});
 const notice=async(text)=>{await page.getByRole('alert').getByText(text,{exact:false}).waitFor();await page.getByRole('button',{name:'关闭提示',exact:true}).click();};
 const screenshot=async(name)=>{await page.mouse.move(0,0);await page.screenshot({path:path.join(output,name),animations:'disabled'});};
 const seedLegacy=async(background)=>page.evaluate(async background=>{const db=await new Promise(resolve=>{const r=indexedDB.open('workday-appearance',1);r.onsuccess=()=>resolve(r.result);});await new Promise((resolve,reject)=>{const tx=db.transaction('appearance','readwrite');tx.objectStore('appearance').delete('current');tx.oncomplete=resolve;tx.onabort=reject;});db.close();localStorage.setItem('workday.appearance',JSON.stringify({theme:'forest',background}));},background);
 try {
  await launch();await settings(); const large=png();assert(large.length>5*1024*1024);
  if(red){
    await upload('large.png','image/png',large);
    await page.waitForFunction(()=>document.documentElement.dataset.background==='true',{},{timeout:10000});
    throw Error('Expected old implementation to reject valid large image');
  }
  assert.equal(await page.getByRole('button',{name:'森林绿',exact:true}).count(),0);
  const small=png(16,16),oldImage='data:image/png;base64,'+small.toString('base64');
  await seedLegacy(oldImage);await app.close();app=null;await launch();await settings();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'mono');
  assert.equal((await current()).background.hash,crypto.createHash('sha256').update(small).digest('hex'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('workday.appearance')),null);
  await page.waitForFunction(()=>document.querySelector('.background-preview')?.naturalWidth===16);
  checks.push('real restart migrates forest to mono, preserves old raster and clears legacy only after commit');
  await app.close();app=null;await launch();await settings();assert.equal((await current()).background.size,small.length);
  checks.push('second restart reads the committed IndexedDB record');
  await page.evaluate(()=>{globalThis.fixtureURLs=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=value=>{const url=create(value);fixtureURLs.add(url);return url;};URL.revokeObjectURL=url=>{fixtureURLs.delete(url);return revoke(url);};globalThis.fixtureCsp=[];document.addEventListener('securitypolicyviolation',e=>fixtureCsp.push(e.violatedDirective));});
  const formats=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=24;c.height=12;c.getContext('2d').fillRect(0,0,24,12);return ['jpeg','webp'].map(type=>[type,c.toDataURL('image/'+type)]);});
  for(const [type,value] of formats){await upload('image.'+type,'image/'+type,Buffer.from(value.split(',')[1],'base64'));await page.waitForFunction(()=>document.querySelector('.appearance-settings')?.getAttribute('aria-busy')==='false');await page.waitForFunction(()=>document.querySelector('.background-preview')?.naturalWidth===24);assert.equal((await current()).background.type,'image/'+type);}
  checks.push('valid JPEG and WebP replace the previous PNG through the same validation path');
  await upload('large.png','image/png',large);
  await page.waitForFunction(()=>document.querySelector('.background-preview')?.naturalWidth===1500);
  const hash=crypto.createHash('sha256').update(large).digest('hex');
  assert.equal((await current()).background.hash,hash);
  assert.equal(await page.evaluate(()=>localStorage.getItem('workday.appearance')),null);
  assert.equal(await page.evaluate(()=>fixtureURLs.size),1);
  checks.push('6.75 MB high entropy PNG keeps original bytes and 1500×1500 pixels; no base64 storage');
  await theme('custom','自定义');
  for(const [label,value] of [['强调色','#7c3aed'],['字号比例','1.2'],['间距比例','1.1'],['圆角比例','1.5'],['面板色','#f8f4ff']])await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByRole('button',{name:'应用',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--mint')==='#7c3aed');
  let computed=await page.getByRole('button',{name:'应用',exact:true}).evaluate(el=>({font:getComputedStyle(el).fontSize,radius:getComputedStyle(el).borderRadius,space:getComputedStyle(document.documentElement).getPropertyValue('--space-8'),color:getComputedStyle(document.documentElement).getPropertyValue('--mint')}));
  assert.equal(computed.font,'15.6px');assert.equal(computed.radius,'13.5px');assert.equal(computed.space,'8.8px');assert.equal(computed.color,'#7c3aed');
  await screenshot('custom-wide.png');
  await page.getByRole('button',{name:'Home',exact:true}).click();
  assert.equal(await page.locator('.panel').first().evaluate(el=>getComputedStyle(el).fontSize),'15.6px');
  const task=await page.evaluate(async()=>{const r=await window.workday.call('tasks.save',{title:'主题验证待办',notes:'',date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),dueDate:null,projectId:null,completed:false});if(!r.ok)throw Error(r.error.message);return r.value;});
  await page.getByRole('button',{name:'编辑与改期 主题验证待办',exact:true}).focus();await page.keyboard.press('Enter');
  const modal=page.getByRole('dialog',{name:'编辑待办'});assert.equal(await modal.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(248, 244, 255)');
  assert.equal(await modal.locator('input').first().evaluate(el=>getComputedStyle(el).fontSize),'14.4px');
  await modal.getByRole('button',{name:'取消',exact:true}).click();await settings();
  checks.push('custom color, font, spacing and rounding affect real controls, Home and Portal modal');
  await theme('blue','蓝白');assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--text-sm')),'12px');
  await theme('mono','黑白');assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--mint')),'#25272c');
  await theme('custom','自定义');assert.equal(await page.getByLabel('强调色',{exact:true}).inputValue(),'#7c3aed');
  let saved=await current();await page.getByLabel('强调色',{exact:true}).fill('invalid');await page.getByRole('button',{name:'应用',exact:true}).click();await notice('变量无效');assert.deepEqual(await current(),saved);
  await page.getByLabel('强调色',{exact:true}).fill('#7c3aed');
  checks.push('preset switches reset tokens; custom settings survive and invalid drafts cannot commit');
  await page.evaluate(()=>{globalThis.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args),tx=this.transaction;r.addEventListener('success',()=>tx.abort(),{once:true});return r;};});
  await themeAttemptFailure();
  await upload('aborted.png','image/png',small);await notice('原设置保留');assert.deepEqual(await current(),saved);assert.equal(await page.evaluate(()=>fixtureURLs.size),1);
  async function themeAttemptFailure(){await page.getByRole('button',{name:'黑白',exact:true}).click();await notice('原设置保留');assert.equal(await page.locator('html').getAttribute('data-theme'),'custom');assert.deepEqual(await current(),saved);}
  await page.evaluate(()=>{IDBObjectStore.prototype.put=originalPut;});
  checks.push('native transaction abort after request success preserves theme and background, and releases the failed replacement URL');
  for(const [name,type,buffer,message] of [['unsafe.svg','image/svg+xml',Buffer.from('<svg/>'),'请选择 PNG'],['fake.png','image/png',Buffer.from('bad'),'图片内容与格式不符'],['broken.png','image/png',small.subarray(0,24),'图片无法打开'],['empty.png','image/png',Buffer.alloc(0),'图片内容为空']]){await upload(name,type,buffer);await notice(message);assert.deepEqual(await current(),saved);}
  assert.equal(await page.evaluate(()=>fixtureURLs.size),1);
  checks.push('invalid files and decode failures preserve image and release temporary URLs');
  await page.evaluate(()=>{globalThis.originalDecode=Image.prototype.decode;const gate=new Promise(resolve=>globalThis.releaseDecode=resolve);Image.prototype.decode=async function(){globalThis.decodeStarted=true;await gate;await originalDecode.call(this);globalThis.decodeFinished=true;};});
  await upload('delayed.png','image/png',small);await page.waitForFunction(()=>globalThis.decodeStarted);
  await page.getByRole('button',{name:'Home',exact:true}).click();await settings();await theme('blue','蓝白');
  await page.evaluate(()=>{releaseDecode();Image.prototype.decode=originalDecode;});await page.waitForFunction(()=>globalThis.decodeFinished);
  assert.equal((await current()).background.hash,hash);assert.equal(await page.locator('html').getAttribute('data-theme'),'blue');
  checks.push('leaving and reopening settings cancels stale upload without overwriting newer theme');
  await theme('custom','自定义');
  for(const width of [760,660]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,860),width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('.custom-theme-fields').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);assert.equal(await page.locator('input[type=file]').isVisible(),false);await screenshot('custom-'+width+'.png');await page.locator('.background-settings').scrollIntoViewIfNeeded();await screenshot('background-'+width+'.png');await page.locator('.theme-options').scrollIntoViewIfNeeded();}
  assert.deepEqual(await page.evaluate(()=>fixtureCsp),[]);
  checks.push('760px and 660px layouts have single-column fields, compact background and no horizontal overflow or CSP violation');
  saved=await current();await app.close();app=null;await launch();await settings();assert.deepEqual(await current(),saved);await page.waitForFunction(()=>document.querySelector('.background-preview')?.naturalWidth===1500);assert.equal(await page.getByLabel('字号比例',{exact:true}).inputValue(),'1.2');
  checks.push('real restart restores original large Blob and committed custom variables');
  await page.getByRole('button',{name:'恢复默认',exact:true}).click();await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--text-sm')==='12px');assert.equal((await current()).background.hash,hash);
  await page.getByRole('button',{name:'移除背景图片',exact:true}).click();await page.waitForFunction(()=>!document.documentElement.dataset.background);assert.equal((await current()).background,null);
  await app.close();app=null;await launch();await settings();assert.equal((await current()).background,null);
  checks.push('reset keeps background; remove clears persisted Blob and survives restart');
  // Abort only migration writes on this reload, then restore the native method.
  await seedLegacy(oldImage);await page.evaluate(()=>localStorage.setItem('fixture.abort-migration','1'));
  await page.context().addInitScript(()=>{if(localStorage.getItem('fixture.abort-migration')){globalThis.nativePut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=nativePut.apply(this,args),tx=this.transaction;request.addEventListener('success',()=>tx.abort(),{once:true});return request;};}});
  await page.reload();await page.getByRole('navigation',{name:'全局导航'}).waitFor();await settings();await notice('原设置保留');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'mono');await page.waitForFunction(()=>document.querySelector('.background-preview')?.naturalWidth===16);
  assert.equal(await current(),null);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('workday.appearance')).theme),'forest');
  await page.evaluate(()=>{localStorage.removeItem('fixture.abort-migration');IDBObjectStore.prototype.put=nativePut;});
  checks.push('migration transaction abort retains old forest preference and renders migrated mono with old image');
  // Hold asynchronous startup opening until the disabled settings UI has been checked.
  await page.evaluate(()=>localStorage.setItem('fixture.delay-startup','1'));
  await page.context().addInitScript(()=>{if(localStorage.getItem('fixture.delay-startup')){const nativeOpen=indexedDB.open.bind(indexedDB);const gate=new Promise(resolve=>globalThis.releaseStartup=resolve);indexedDB.open=(...args)=>{const request=nativeOpen(...args);Object.defineProperty(request,'onsuccess',{set(callback){request.addEventListener('success',event=>{globalThis.startupWaiting=true;void gate.then(()=>callback.call(request,event));});},configurable:true});return request;};}});
  await page.reload();await page.getByRole('navigation',{name:'全局导航'}).waitFor();await settings(false);await page.waitForFunction(()=>globalThis.startupWaiting);
  assert.equal(await page.getByRole('button',{name:'蓝白',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{localStorage.removeItem('fixture.delay-startup');releaseStartup();});await page.waitForFunction(()=>document.querySelector('.appearance-settings')?.getAttribute('aria-busy')==='false');await theme('blue','蓝白');
  assert.equal((await current()).theme,'blue');
  checks.push('asynchronous startup disables appearance editing until restoration finishes; the subsequent selection persists');
  assert.deepEqual(errors,[]);
  const state=await page.evaluate(()=>window.workday.call('state.get',{}));assert.equal(state.ok,true);assert.deepEqual(state.value.tasks,[task]);assert.equal(state.value.sources.length,0);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,largeBytes:large.length,largeHash:hash,kind,realElectron:true,personalData:false,dataDirectory:data},null,2));
  console.log(JSON.stringify({passed:true,kind,checks,output},null,2));
 } catch(error) { if(page&&!page.isClosed()){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error('Visible alerts:',await page.getByRole('alert').allTextContents());}throw error; }
 finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
