// Isolated real renderer acceptance: synthetic RuntimeContext and fail-closed IPC.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..');
const output = path.join(project, 'output/playwright/remove-more-context');
const baseline = process.argv.includes('--red');
const logFile = path.join(project, baseline ? 'test-results/remove-more-context/browser-red.log' : 'test-results/remove-more-context/browser-green.log');
const logs = [];
function log(text) { logs.push(text); console.log(text); }
const harness = String.raw`
import '@mantine/core/styles.css';
import '${project}/src/renderer/style.css';
import React,{useState,useRef,useCallback,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Chat} from '${project}/src/renderer/chat';
import {RuntimeContext} from '${project}/src/renderer/ui';
import {WorkDayProvider} from '${project}/src/renderer/component-theme';
import {defaultAppearance,applyAppearance} from '${project}/src/renderer/appearance';
import {emptyContext} from '${project}/src/shared/types';
const theme=new URLSearchParams(location.search).get('theme')||'mono';
applyAppearance(document.documentElement,{...defaultAppearance(),theme});
window.workday={subscribe:()=>()=>{}};
const entity=(id,version=1)=>({id,version,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'});
const model={sourceId:'fixture',modelId:'test-one'};
const source={...entity('fixture'),name:'Synthetic Source',enabled:true,models:[{id:'test-one',name:'Fixture One',supportsTools:true},{id:'test-two',name:'Fixture Two',supportsTools:true}]};
const initial={gitAccount:null,tasks:[],projects:[{...entity('project-one'),name:'Fixture Project',description:'',directory:'/SYNTHETIC/project',archived:false},{...entity('project-two'),name:'Other Project',archived:false}],conversations:[{...entity('chat-one'),title:'Current fixture chat',projectId:'project-one',model,context:emptyContext(),activeRequestId:null,archived:false},{...entity('chat-two'),title:'Reference conversation',projectId:'project-one',model,context:emptyContext(),activeRequestId:null,archived:false}],sources:[source],knowledge:[{...entity('knowledge',3),name:'参考资料',content:'Synthetic knowledge text',projectId:'project-one',removed:false},{...entity('private',1),name:'Other private data',content:'unselected',projectId:'project-two',removed:false}],skills:[{...entity('skill',2),name:'Review Skill',description:'English review description',descriptionZh:'审查描述',content:'# fixture',enabled:true,ownerPluginId:null},{...entity('component',4),name:'Pack Skill',description:'fixture',content:'# package fixture',enabled:true,ownerPluginId:'plugin'}],plugins:[{...entity('plugin',7),pluginKey:'fixture.plugin',name:'Fixture Plugin',description:'bundle',descriptionZh:'插件说明',packageVersion:'1.0.0',enabled:true,skillIds:['component'],mcpIds:[]}],mcpServers:[],grants:[],drafts:[],schedules:[],runs:[],defaultModel:model,dataDirectory:'/SYNTHETIC',appVersion:'fixture'};
function Harness(){
 const [state,setState]=useState(initial),stateRef=useRef(state);stateRef.current=state;
 const [route,setRoute]=useState({id:'chat-one',projectId:'project-one',date:'2026-10-26',home:false});
 const calls=useRef([]),reports=useRef([]),next=useRef(0),delay=useRef({}),attachments=useRef([]);
 const update=useCallback(fn=>{const value=fn(stateRef.current);stateRef.current=value;setState(value);},[]);
 const call=useCallback(async(op,input)=>{calls.current.push({op,input:structuredClone(input)});
  const ms=delay.current[op+':'+(input.query??'')]??delay.current[op]??0;if(ms)await new Promise(r=>setTimeout(r,ms));
  if(op==='conversations.history')return [];
  if(op==='components.session')return null;
  if(op==='context.conversations')return stateRef.current.conversations.filter(c=>c.id!==input.owner.conversationId&&!c.archived&&!c.activeRequestId&&c.title.toLowerCase().includes((input.query||'').toLowerCase())).map(c=>({id:c.id,version:c.version,title:c.title,projectName:'Fixture Project',digest:'digest-'+c.id,preview:'Synthetic reference content'}));
  if(op==='context.attachments.pick')return attachments.current;
  if(op==='context.attachments.preview')return {};
  if(op==='context.attachments.remove')return;
  if(op==='conversations.create'){const result={...entity('created-'+(++next.current)),title:'New fixture chat',projectId:input.projectId,model:input.model,context:{...emptyContext(),date:input.date},activeRequestId:null,archived:false};update(s=>({...s,conversations:[...s.conversations,result]}));return result;}
  if(op==='conversations.context'){const result={...stateRef.current.conversations.find(c=>c.id===input.id),context:input.context};update(s=>({...s,conversations:s.conversations.map(c=>c.id===result.id?result:c)}));return result;}
  if(op==='chat.send')return {requestId:'synthetic-request'};
  if(op==='chat.cancel')return;
  throw Error('Unexpected IPC blocked: '+op);
 },[]);
 const openChat=useCallback((id,projectId)=>setRoute(r=>({...r,id,projectId:projectId??null,home:false})),[]);
 window.__fixture={state:()=>stateRef.current,calls:()=>calls.current,reports:()=>reports.current,route:()=>route,openChat,change:(r)=>setRoute(old=>({...old,...r})),delay:(op,ms)=>{delay.current[op]=ms},update,attachments:items=>{attachments.current=items}};
 return <WorkDayProvider appearance={theme}><RuntimeContext.Provider value={{state,call:async(op,input)=>call(op,input),refresh:async()=>{},report:t=>reports.current.push(t),go:p=>reports.current.push('go:'+p),openChat,browseProject:()=>{}}}><main style={{padding:12,height:'100vh',display:'flex'}}><Chat conversationId={route.id} newProjectId={route.projectId} date={route.date} newDate={route.date} onProjectChange={route.home?(projectId)=>setRoute(r=>({...r,projectId})):undefined}/></main></RuntimeContext.Provider></WorkDayProvider>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Harness/></StrictMode>);
`;
async function main(){
 await fs.mkdir(output,{recursive:true});await fs.mkdir(path.dirname(logFile),{recursive:true});
 const temp=await fs.mkdtemp('/tmp/workday-composer-commands-browser-');
 await fs.symlink(path.join(project,'node_modules'),path.join(temp,'node_modules'));
 await fs.writeFile(path.join(temp,'index.html'),'<!DOCTYPE html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/harness.tsx"></script></html>');
 await fs.writeFile(path.join(temp,'harness.tsx'),harness);
 const {build}=await import(pathToFileURL(path.join(project,'node_modules/vite/dist/node/index.js')).href);
 await build({configFile:false,root:temp,base:'./',publicDir:false,esbuild:{jsx:'automatic'},build:{outDir:path.join(temp,'dist'),emptyOutDir:true},logLevel:'error'});
 const server=http.createServer(async(req,res)=>{try{let name=new URL(req.url,'http://local').pathname;if(name==='/')name='/index.html';res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(path.join(temp,'dist',name)));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;let browser;const checks=[],frames=[],errors=[],external=[];
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>{if(r.request().url().startsWith(base))return r.continue();external.push(r.request().url());return r.abort();});
  const input=page.getByRole('textbox',{name:'消息输入',exact:true});
  await page.goto(base);await input.waitFor();
  for(const home of [false,true]){
   await page.evaluate(home=>__fixture.change({id:home?null:'chat-one',home}),home);
   await page.getByRole('button',{name:'添加上下文',exact:true}).click();
   assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['上传附件','选择对话','Skill','插件']);
   await page.keyboard.press('Escape');
   assert.equal(await page.getByRole('dialog',{name:'选择本次对话上下文',exact:true}).count(),0);
  }
  checks.push('chat and home menus expose only the four direct context actions');
  await page.goto(base);await input.fill('/');
  await page.getByRole('listbox',{name:'快捷命令',exact:true}).waitFor({timeout:2500});
  assert.equal(await page.getByRole('option').count(),5);checks.push('slash exposes only commands with live destinations');
  if(!baseline){

   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   const fresh=async()=>{await page.goto(base);await input.waitFor();};
   const choice=(text)=>page.getByRole('option').filter({hasText:text});
   const noMenu=async()=>{await page.locator('.composer-suggestions').waitFor({state:'detached'});};
   const close=async()=>{await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});};
   const command=async(id,title)=>{await input.fill('/'+id);await choice(title).click();};
   const frame=async(name)=>{await page.screenshot({path:path.join(output,name),fullPage:true});frames.push(name);};
   await input.press('Escape');await noMenu();await page.evaluate(()=>__fixture.update(s=>({...s})));await noMenu();
   await input.fill('/mo');await input.press('ArrowDown');await input.press('Enter');
   await page.getByRole('option',{name:'Fixture Two',exact:true}).click();
   assert.equal(await input.inputValue(),'');assert.equal(await page.getByRole('combobox',{name:'选择模型与模型源'}).inputValue(),'Fixture Two');checks.push('Esc stays closed; slash filtering and model picker execute');
   await fresh();await input.fill('before @Review after');await input.evaluate(e=>e.setSelectionRange(14,14));await input.press('ArrowLeft');await input.press('ArrowRight');
   await choice('Review Skill').click();assert.equal(await input.inputValue(),'before  after');
   await page.waitForFunction(()=>document.querySelector('textarea').selectionStart===7);assert.equal(await page.getByRole('button',{name:'移除上下文 Review Skill'}).count(),1);checks.push('middle token replacement preserves both sides and caret');
   await fresh();await input.fill('@Review');await input.press('Control+a');await input.press('Enter');assert.equal(await page.locator('.context-chip').count(),0);checks.push('selected text cannot consume a stale trigger');
   await fresh();await input.fill('@Review');await input.press('Enter');await page.getByRole('button',{name:'移除上下文 Review Skill'}).waitFor();
   await input.fill('@Reference');await choice('Reference conversation').waitFor();await input.press('Tab');await page.getByRole('button',{name:'移除上下文 Reference conversation'}).waitFor();
   await input.fill('@资料');await choice('参考资料').click();assert.equal(await page.getByRole('button',{name:'移除上下文 参考资料',exact:true}).count(),1);
   await input.fill('@资料');await choice('参考资料').click();assert.equal(await page.getByRole('button',{name:'移除上下文 参考资料',exact:true}).count(),1);
   await input.fill('Synthetic request');await input.press('Control+Enter');
   await page.waitForFunction(()=>__fixture.calls().some(c=>c.op==='chat.send'));
   const sent=await page.evaluate(()=>__fixture.calls().find(c=>c.op==='chat.send').input);
   assert.deepEqual(sent.context.skillRef,{id:'skill',version:2});assert.deepEqual(sent.context.knowledgeRefs,[{id:'knowledge',version:3}]);assert.deepEqual(sent.context.conversationRefs,[{id:'chat-two',version:1,digest:'digest-chat-two'}]);assert.equal(sent.text,'Synthetic request');assert.equal(sent.owner.projectId,'project-one');checks.push('actual send carries selected Skill, knowledge, version and digest; duplicate selection stays unique');
   await fresh();await input.fill('@Fixture');await choice('Fixture Plugin').click();await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();assert.equal(await page.locator('.context-chip').count(),0);
   await page.getByRole('checkbox').filter({has:page.locator('input')}).count();
   await page.getByRole('checkbox',{name:/Pack Skill/}).check();await page.getByRole('button',{name:'添加所选组件',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
   await page.getByRole('button',{name:'移除上下文 Fixture Plugin',exact:true}).waitFor();
   await input.fill('@Review');await choice('Review Skill').click();assert.equal(await page.getByRole('button',{name:'移除上下文 Fixture Plugin',exact:true}).count(),0);checks.push('plugin selection opens actual component confirmation; standalone Skill clears plugin ownership');
   await fresh();for(const removed of ['context','mcp']){await input.fill('/'+removed);await noMenu();assert.equal(await input.inputValue(),'/'+removed);assert.equal(await page.getByRole('dialog').count(),0);}
   await input.fill('@资料');await choice('参考资料').click();await page.getByRole('button',{name:'移除上下文 参考资料',exact:true}).click();assert.equal(await page.locator('.context-chip').count(),0);checks.push('removed popup commands stay plain text; knowledge chips can be removed without a modal');
   await command('skill','选择 Skill');await page.getByRole('dialog',{name:'选择 Skill'}).waitFor();await close();
   await command('plugin','选择插件');await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();await close();
   checks.push('skill and plugin commands keep their dedicated selectors');
   await command('attach','上传附件');await page.waitForFunction(()=>__fixture.calls().some(c=>c.op==='context.attachments.pick'));assert.equal(await page.locator('.context-chip').count(),0);
   await page.evaluate(()=>__fixture.attachments([{token:'file-1',name:'synthetic.txt',mime:'text/plain',size:12}]));await command('attach','上传附件');await page.getByRole('button',{name:'移除附件 synthetic.txt',exact:true}).waitFor();checks.push('attach cancellation and selection reuse actual picker');
   await fresh();await input.fill('/new preserved');await input.evaluate(e=>e.setSelectionRange(4,4));await input.press('ArrowLeft');await input.press('ArrowRight');await input.press('Enter');
   await page.waitForFunction(()=>__fixture.route().id?.startsWith('created-'));const created=await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='conversations.create'));assert.equal(created.length,1);assert.equal(created[0].input.projectId,'project-one');
   await page.evaluate(()=>__fixture.openChat('chat-one','project-one'));await page.waitForFunction(()=>document.querySelector('textarea').value===' preserved');checks.push('new chat creates once in the same project and retains original draft');
   await fresh();for(const text of ['a@b.com','https://test/@person','/usr/bin','body /model','/unknown']){await input.fill(text);await noMenu();assert.equal(await input.inputValue(),text);}
   await input.press('Enter');assert.equal(await input.inputValue(),'/unknown\n');checks.push('emails, URLs, paths and unknown commands retain ordinary Enter behavior');
   await input.fill('@Review');await input.dispatchEvent('compositionstart');await noMenu();await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,ctrlKey:true,keyCode:229});
   assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='chat.send').length),0);assert.equal(await page.locator('.context-chip').count(),0);
   await input.dispatchEvent('compositionend');await choice('Review Skill').waitFor();await input.press('Escape');await noMenu();checks.push('IME suppresses suggestion navigation, selection and send shortcut');
   await fresh();await input.fill('@Review');await page.mouse.click(20,20);await noMenu();await page.evaluate(()=>__fixture.update(s=>({...s})));await noMenu();
   await input.click();await choice('Review Skill').waitFor();await page.evaluate(()=>__fixture.update(s=>({...s,skills:s.skills.map(v=>v.id==='skill'?{...v,enabled:false}:v)})));await choice('Review Skill').waitFor({state:'detached'});checks.push('outside dismiss remains closed; disabled candidates are removed before selection');
   await fresh();await input.fill('@Reference');await choice('Reference conversation').waitFor();
   const queryCount=await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='context.conversations').length);
   for(let i=0;i<4;i++)await page.evaluate(()=>__fixture.update(s=>({...s})));
   await sleep(300);assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='context.conversations').length),queryCount);checks.push('unstable runtime call identities do not repeat searches');
   await fresh();await page.evaluate(()=>{__fixture.delay('context.conversations:Reference',550);__fixture.delay('context.conversations:missing',10)});
   await input.fill('@Reference');await sleep(150);await input.fill('@missing');await sleep(650);assert.equal(await choice('Reference conversation').count(),0);assert.equal(await input.inputValue(),'@missing');checks.push('latest-only reverse-order search results');
   await fresh();await input.fill('@Reference');await choice('Reference conversation').waitFor();await page.evaluate(()=>__fixture.delay('context.conversations:Reference',500));await input.press('Enter');await input.press('Escape');await sleep(650);assert.equal(await page.locator('.context-chip').count(),0);assert.equal(await input.inputValue(),'@Reference');checks.push('Esc cancels in-flight conversation revalidation');
   await fresh();await page.evaluate(()=>__fixture.delay('context.conversations:Reference',500));await input.fill('@Reference');await sleep(150);
   await page.evaluate(()=>__fixture.openChat('chat-two','project-one'));await sleep(600);await noMenu();assert.equal(await input.inputValue(),'');checks.push('slow search cannot cross chat owner');
   await fresh();await page.evaluate(()=>__fixture.change({id:null,home:true}));await input.fill('@Reference');await choice('Reference conversation').waitFor();await page.evaluate(()=>__fixture.change({date:'2026-10-27'}));await noMenu();
   await input.click();await choice('Reference conversation').waitFor();await page.evaluate(()=>__fixture.change({projectId:'project-two'}));await noMenu();assert.equal(await input.inputValue(),'');checks.push('home composer supports @; calendar date and project changes invalidate menu');
   await fresh();await input.fill('/');await page.evaluate(()=>__fixture.update(s=>({...s,conversations:s.conversations.map(c=>c.id==='chat-one'?{...c,activeRequestId:'fixture-running'}:c)})));await noMenu();await input.fill('@Review');await noMenu();checks.push('generation closes and blocks new entry points');
   await fresh();await page.evaluate(()=>__fixture.delay('conversations.create',500));await command('new','新建聊天');await page.evaluate(()=>__fixture.openChat('chat-two','project-one'));await sleep(650);assert.equal(await page.evaluate(()=>__fixture.route().id),'chat-two');checks.push('late /new completion cannot pull user back');
   await fresh();await page.evaluate(()=>{__fixture.delay('context.attachments.pick',500);__fixture.attachments([{token:'old-file',name:'old.txt',mime:'text/plain',size:1}]);});await command('attach','上传附件');
   await page.evaluate(()=>__fixture.change({date:'2026-10-27'}));await sleep(650);assert.equal(await page.locator('.context-chip').count(),0);assert.ok(await page.evaluate(()=>__fixture.calls().some(c=>c.op==='context.attachments.remove'&&c.input.tokens.includes('old-file'))));checks.push('late upload cleans old scope tokens instead of attaching to another date');
   await fresh();await page.evaluate(()=>{__fixture.update(s=>({...s,sources:[],defaultModel:null}));__fixture.change({id:null,home:true});});await command('model','切换模型');
   await page.waitForFunction(()=>__fixture.reports().includes('go:设置'),{},{timeout:2500});checks.push('/model without a configured source opens actual model settings');
   await fresh();await page.evaluate(()=>{
    __fixture.update(s=>({...s,tasks:[{id:'legacy-task',title:'已选待办'}],mcpServers:[{id:'server',name:'Fixture MCP',enabled:true,tools:[]}],conversations:s.conversations.map(c=>c.id==='chat-two'?{...c,context:{...c.context,taskIds:['legacy-task'],knowledgeRefs:[{id:'knowledge',version:3}],mcpRefs:[{id:'server',configVersion:1,capabilityNames:['manual','plugin-tool']}],pluginRefs:[{id:'plugin',version:7,skillId:null,mcpRefs:[{id:'server',configVersion:1,capabilityNames:['plugin-tool']}]}]}}:c)}));
    __fixture.openChat('chat-two','project-one');
   });
   await page.getByRole('button',{name:'移除上下文 已选待办',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'移除上下文 Fixture MCP · plugin-tool',exact:true}).count(),0);
   assert.equal(await page.locator('.context-more-count').count(),0);
   await page.getByRole('button',{name:'移除上下文 已选待办',exact:true}).click();
   await page.getByRole('button',{name:'移除上下文 参考资料',exact:true}).click();
   await page.getByRole('button',{name:'移除上下文 Fixture MCP · manual',exact:true}).click();
   await page.getByRole('button',{name:'移除上下文 Fixture Plugin',exact:true}).waitFor();
   assert.equal(await page.getByRole('dialog').count(),0);
   await input.fill('Preserve plugin tools');await input.press('Control+Enter');
   await page.waitForFunction(()=>__fixture.calls().some(c=>c.op==='chat.send'));
   const remaining=await page.evaluate(()=>__fixture.calls().find(c=>c.op==='chat.send').input.context);
   assert.deepEqual(remaining.taskIds,[]);assert.deepEqual(remaining.knowledgeRefs,[]);
   assert.deepEqual(remaining.mcpRefs,[{id:'server',configVersion:1,capabilityNames:['plugin-tool']}]);
   assert.deepEqual(remaining.pluginRefs,[{id:'plugin',version:7,skillId:null,mcpRefs:remaining.mcpRefs}]);
   checks.push('restored task, knowledge and standalone MCP chips remove only their own references, preserving plugin-owned tools in the actual send payload');
   for(const theme of ['mono','blue'])for(const width of [1500,660]){
    await page.setViewportSize({width,height:900});await page.goto(base+'/?theme='+theme);await input.fill('/');await page.getByRole('listbox',{name:'快捷命令'}).waitFor();
    const box=await page.locator('.composer-suggestions').boundingBox(),editor=await page.locator('.composer-input').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=editor.y);await frame(`slash-${theme}-${width}.png`);
    await input.fill('@');await sleep(200);await frame(`mention-${theme}-${width}.png`);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   }checks.push('wide/narrow theme layouts remain above composer without horizontal overflow');

  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await fs.writeFile(path.join(output,baseline?'red.json':'result.json'),JSON.stringify({passed:true,checks,frames,errors,external},null,2));log(JSON.stringify({passed:true,checks:checks.length,output}));
 }catch(e){await fs.writeFile(path.join(output,baseline?'red.json':'failure.json'),JSON.stringify({error:String(e),checks,frames,errors},null,2));throw e;}
 finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{log('FAIL '+(e.stack||e));process.exitCode=1;}).finally(()=>fs.writeFile(logFile,logs.join('\n')+'\n'));
