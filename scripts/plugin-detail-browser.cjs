// Isolated real renderer acceptance: synthetic RuntimeContext and fail-closed IPC.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..');
const output = path.join(project, 'output/playwright/plugin-detail');
const lifecycleRed = process.argv.includes('--lifecycle-red');
const logFile = path.join(project, lifecycleRed ? 'test-results/plugin-detail-browser-lifecycle-red.log' : 'test-results/plugin-detail-browser.log');
const logs = [];
function log(text) { logs.push(text); console.log(text); }
const harness = String.raw`
import '@mantine/core/styles.css';
import '${project}/src/renderer/style.css';
import React,{useState,useRef,useCallback,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {PluginsPage} from '${project}/src/renderer/plugins';
import {Chat} from '${project}/src/renderer/chat';
import {RuntimeContext} from '${project}/src/renderer/ui';
import {WorkDayProvider} from '${project}/src/renderer/component-theme';
import {defaultAppearance,applyAppearance} from '${project}/src/renderer/appearance';
import {emptyContext} from '${project}/src/shared/types';
const theme=new URLSearchParams(location.search).get('theme')||'mono';
applyAppearance(document.documentElement,{...defaultAppearance(),theme});
window.workday={subscribe:()=>()=>{}};
const entity=(id,version=1)=>({id,version,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'});
const long='非常长的插件名称用于验证按钮和文字布局'.repeat(8);
const plugins=[['one','Single Skill',[ 'one-s' ],[],true],['many','Multiple Skills',['many-a','many-b'],[],true],['zero','MCP Only',[],['zero-m'],true],['off','Disabled Plugin',['off-s'],[],false],['long',long,['long-s'],[],true]].map(([id,name,skillIds,mcpIds,enabled])=>({...entity(id,7),pluginKey:'fixture.'+id,name,description:id==='long'?'长描述以及长英文不换行序列 '+('longdescription'.repeat(24)):name+' synthetic plugin description.',packageVersion:'2.3.4',enabled,skillIds,mcpIds}));
const skills=plugins.flatMap(p=>p.skillIds.map(id=>({...entity(id,4),name:id==='long-s'?'很长的技能名称'.repeat(25):id+' skill',description:id==='long-s'?'LongSkillDescription'.repeat(24):'A synthetic skill for isolated verification.',content:'# Synthetic Skill\n\nUse only fixture data.',enabled:true,ownerPluginId:p.id})));
const server={...entity('zero-m'),name:'Fixture MCP',transport:'http',command:null,args:[],url:'https://never-call.invalid/mcp',enabled:true,ownerPluginId:'zero',configVersion:3,credentialConfigured:false,tools:[{name:'read_fixture',description:'read fixture',inputSchema:{type:'object',properties:{}}}],resources:[],prompts:[],discoveredAt:null};
const initial={gitAccount:null,tasks:[],projects:[{...entity('project-one'),name:'Fixture Project',description:'',directory:'/SYNTHETIC/project',archived:false}],conversations:[{...entity('project-chat'),title:'Existing project chat',projectId:'project-one',model:null,context:emptyContext(),activeRequestId:null,archived:false}],sources:[],knowledge:[],skills,mcpServers:[server],grants:[],plugins,drafts:[],schedules:[],runs:[],defaultModel:null,dataDirectory:'/SYNTHETIC',appVersion:'fixture'};
function Harness(){
 const [state,setState]=useState(initial),stateRef=useRef(state);stateRef.current=state;
 const [route,setRoute]=useState({page:'插件',id:null,projectId:null,key:0});
 const calls=useRef([]),reports=useRef([]),next=useRef(0),failContext=useRef(false);
 const update=useCallback(fn=>{const value=fn(stateRef.current);stateRef.current=value;setState(value);},[]);
 const call=useCallback(async(op,input)=>{calls.current.push({op,input:structuredClone(input)});let result;
  if(op==='conversations.create'){result={...entity('chat-'+(++next.current)),title:input.title,projectId:input.projectId,model:input.model,context:{...emptyContext(),date:input.date},activeRequestId:null,archived:false};update(s=>({...s,conversations:[...s.conversations,result]}));return result;}
  if(op==='conversations.context'){if(failContext.current){failContext.current=false;throw Error('Synthetic context failure');}const c=stateRef.current.conversations.find(c=>c.id===input.id);if(c.version!==input.expectedVersion)throw Error('fixture stale version');result={...c,version:c.version+1,context:input.context};update(s=>({...s,conversations:s.conversations.map(c=>c.id===result.id?result:c)}));return result;}
  if(op==='conversations.history')return [];
  if(op==='components.session')return null;
  if(op==='plugins.toggle'){update(s=>({...s,plugins:s.plugins.map(p=>p.id===input.id?{...p,version:p.version+1,enabled:input.enabled}:p)}));return;}
  throw Error('Unexpected IPC blocked: '+op);
 },[]);
 const openChat=useCallback((id,knownProjectId)=>setRoute(r=>({page:'chat',id,projectId:knownProjectId!==undefined?knownProjectId:stateRef.current.conversations.find(c=>c.id===id)?.projectId??null,key:r.key})),[]);
 const go=useCallback(page=>setRoute(r=>({...r,page})),[]);
 window.__fixture={state:()=>stateRef.current,calls:()=>calls.current,reports:()=>reports.current,route:()=>route,openChat,go,remount:()=>setRoute(r=>({...r,key:r.key+1})),failNextContext:()=>{failContext.current=true;},createEmpty:()=>call('conversations.create',{title:'Other chat',projectId:null,date:null,model:null})};
 return <WorkDayProvider appearance={theme}><RuntimeContext.Provider value={{state,call,refresh:async()=>{},report:t=>reports.current.push(t),go,openChat,browseProject:()=>{}}}><main style={{padding:12,minHeight:'100vh'}}><div>{route.page==='插件'&&<PluginsPage key={route.key}/>}</div><aside hidden={route.page!=='chat'}><div style={{height:'calc(100vh - 24px)',display:'flex'}}><Chat key={route.key} conversationId={route.id} newProjectId={route.projectId} date={null}/></div></aside></main></RuntimeContext.Provider></WorkDayProvider>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Harness/></StrictMode>);
`;
async function main(){
 await fs.mkdir(output,{recursive:true});await fs.mkdir(path.dirname(logFile),{recursive:true});
 const temp=await fs.mkdtemp('/tmp/workday-plugin-detail-');
 await fs.symlink(path.join(project,'node_modules'),path.join(temp,'node_modules'));
 await fs.writeFile(path.join(temp,'index.html'),'<!DOCTYPE html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/harness.tsx"></script></html>');
 await fs.writeFile(path.join(temp,'harness.tsx'),harness);
 const {build}=await import(pathToFileURL(path.join(project,'node_modules/vite/dist/node/index.js')).href);
 await build({configFile:false,root:temp,base:'./',publicDir:false,esbuild:{jsx:'automatic'},build:{outDir:path.join(temp,'dist'),emptyOutDir:true},logLevel:'error'});
 const server=http.createServer(async(req,res)=>{try{let name=new URL(req.url,'http://local').pathname;if(name==='/')name='/index.html';const file=path.join(temp,'dist',name);res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();external.push(route.request().url());return route.abort();});
  async function fresh(theme='mono'){await page.goto(base+'/?theme='+theme);await page.getByRole('tab',{name:'Plugin',exact:true}).click();}
  async function detail(name){await page.getByRole('button',{name:'查看 '+name,exact:true}).click();await page.locator('.plugin-detail-page').waitFor();assert.equal(await page.getByRole('dialog').count(),0);}
  async function closeModal(){await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});}
  async function chat(){await page.getByRole('textbox',{name:'消息输入'}).waitFor();}
  async function noSend(){assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>/send|grant|mcp\.|attachments/.test(c.op)).length),0);}
  async function verifyProjectReturn(){
   await fresh();await page.evaluate(()=>__fixture.openChat('project-chat'));await chat();assert.equal(await page.evaluate(()=>__fixture.route().projectId),'project-one');
   await page.getByRole('button',{name:'添加上下文',exact:true}).click();await page.getByRole('menuitem',{name:'插件',exact:true}).click();
   await page.locator('.context-choice-button').filter({hasText:'MCP Only'}).click();await page.getByRole('button',{name:'前往插件页配置'}).click();await page.getByRole('dialog',{name:'管理 · MCP Only'}).waitFor();
   await page.getByRole('button',{name:'查看 Fixture MCP',exact:true}).click();assert.ok(await page.locator('select').evaluateAll(els=>els.some(e=>e.value==='project-chat')));
   await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('dialog',{name:'管理 · MCP Only'}).waitFor({state:'detached'});await chat();
   const result=await page.evaluate(()=>({route:__fixture.route(),pickerOpen:!![...document.querySelectorAll('[role="dialog"]')].find(d=>d.textContent.includes('选择插件组件')),creates:__fixture.calls().filter(c=>c.op==='conversations.create').length}));
   log('MOUNTED_CHAT_RETURN '+JSON.stringify(result));await page.screenshot({path:path.join(output,lifecycleRed?'mounted-chat-return-red.png':'mounted-chat-return.png'),fullPage:true});
   assert.equal(result.route.id,'project-chat');assert.equal(result.creates,0);
   assert.ok(result.pickerOpen&&result.route.projectId==='project-one','Persistently mounted Chat must reopen the same plugin picker and preserve original project: '+JSON.stringify(result));await noSend();
   log('PASS persistently mounted project chat → MCP management → same chat/project with reopened picker');
  }
  if(lifecycleRed){await verifyProjectReturn();return;}
  await fresh();await detail('Single Skill');
  await page.getByRole('button',{name:'管理',exact:true}).click();await page.getByRole('dialog',{name:'管理 · Single Skill'}).waitFor();await closeModal();assert.equal(await page.locator('.plugin-detail-page').count(),1);
  await page.getByRole('button',{name:'查看 Skill one-s skill',exact:true}).click();await page.getByRole('region',{name:'Skill 说明'}).waitFor();await page.getByRole('button',{name:'关闭详情'}).click();await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.locator('.plugin-detail-page').count(),1);
  await page.getByRole('button',{name:'Plugin 更多操作'}).click();await page.getByRole('menuitem',{name:'卸载插件'}).click();await page.getByRole('dialog',{name:'卸载 Plugin'}).waitFor();assert.equal(await page.getByRole('button',{name:'卸载此包'}).count(),1);await closeModal();assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='plugins.uninstall').length),0);
  await page.getByRole('button',{name:'返回插件'}).click();await page.getByRole('list',{name:'Plugin 列表'}).waitFor();
  log('PASS list → inline detail → management → detail; skill detail → plugin; uninstall confirmation; return list');
  await detail('Single Skill');await page.getByRole('button',{name:'立即试用',exact:true}).click();await chat();
  let c=await page.evaluate(()=>__fixture.state().conversations.at(-1));assert.deepEqual(c.context.skillRef,{id:'one-s',version:4});assert.deepEqual(c.context.pluginRefs,[{id:'one',version:7,skillId:'one-s',mcpRefs:[]}]);await noSend();
  log('PASS single Skill trial uses actual plugin/skill versions, no send');
  await fresh();await detail('Multiple Skills');await page.getByRole('button',{name:'立即试用',exact:true}).click();await chat();await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();
  assert.equal(await page.locator('.context-choice.selected').innerText().then(x=>x.includes('Multiple Skills')),true);c=await page.evaluate(()=>__fixture.state().conversations.at(-1));assert.equal((c.context.pluginRefs||[]).length,0);assert.equal(await page.getByRole('button',{name:'添加所选组件'}).isDisabled(),true);
  await page.getByRole('checkbox',{name:'many-a skill · 依赖未验证',exact:true}).check();await page.getByRole('button',{name:'添加所选组件'}).click();await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await page.getByLabel('已选上下文').innerText().then(x=>x.includes('Multiple Skills')),true);
  await page.evaluate(()=>__fixture.remount());await chat();assert.equal(await page.getByRole('dialog').count(),0);await noSend();
  log('PASS multiple Skills opens correct plugin once, no empty ref, explicit selection produces chip; remount does not reopen');
  await fresh();await detail('MCP Only');await page.getByRole('button',{name:'立即试用',exact:true}).click();await chat();await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();assert.equal(await page.getByRole('button',{name:'添加所选组件'}).isDisabled(),true);
  const zeroId=await page.evaluate(()=>__fixture.route().id);c=await page.evaluate(()=>__fixture.state().conversations.at(-1));assert.equal((c.context.pluginRefs||[]).length,0);await noSend();
  await page.getByRole('button',{name:'前往插件页配置'}).click();await page.getByRole('dialog',{name:'管理 · MCP Only'}).waitFor();assert.equal(await page.locator('.plugin-detail-page').count(),1);await noSend();
  await page.getByRole('button',{name:'查看 Fixture MCP',exact:true}).click();
  const selects=await page.locator('select').evaluateAll(els=>els.map(e=>({value:e.value,labels:Array.from(e.labels||[]).map(l=>l.innerText)})));assert.ok(selects.some(s=>s.value===zeroId),'MCP management keeps trial conversation');await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();assert.equal(await page.evaluate(()=>__fixture.route().id),zeroId);assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='conversations.create').length),1);await noSend();
  log('PASS zero Skill/MCP chooser has no empty ref/automatic grant; management and return keep exact trial conversation without creating another');
  await verifyProjectReturn();
  await fresh();await detail('Multiple Skills');await page.getByRole('button',{name:'立即试用',exact:true}).click();await chat();await page.getByRole('dialog',{name:'选择插件组件'}).waitFor();const oldId=await page.evaluate(()=>__fixture.route().id);await page.evaluate(async()=>{const other=await __fixture.createEmpty();__fixture.openChat(other.id);});await page.getByRole('dialog').waitFor({state:'detached'});await page.evaluate(id=>__fixture.openChat(id),oldId);await chat();assert.equal(await page.getByRole('dialog').count(),0);
  log('PASS scope change dismisses old picker; returning to same chat does not replay once-only intent');
  await fresh();await detail('Multiple Skills');await page.getByRole('button',{name:'试用 many-b skill',exact:true}).click();await chat();assert.equal(await page.getByRole('textbox',{name:'消息输入'}).inputValue(),'使用 many-b skill 帮我完成一项任务。');c=await page.evaluate(()=>__fixture.state().conversations.at(-1));assert.equal(c.context.skillRef.id,'many-b');assert.equal(await page.getByRole('dialog').count(),0);await noSend();
  log('PASS example pre-fills actual skill prompt and context without send');
  await fresh();await detail('Single Skill');await page.evaluate(()=>__fixture.failNextContext());await page.getByRole('button',{name:'立即试用',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic context failure'}).waitFor();assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='conversations.create').length),1);await page.getByRole('button',{name:'立即试用',exact:true}).click();await chat();assert.equal(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='conversations.create').length),1);await noSend();
  log('PASS context save failure retries the original created conversation');
  await fresh();await detail('Disabled Plugin');assert.equal(await page.getByRole('button',{name:'立即试用',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'试用 off-s skill',exact:true}).isDisabled(),true);await noSend();
  log('PASS disabled plugin disables trial and examples');
  for(const theme of ['mono','blue'])for(const width of [1500,660]){
   await page.setViewportSize({width,height:1000});await fresh(theme);await page.getByRole('button',{name:/^查看 非常长/}).click();await page.locator('.plugin-detail-page').waitFor();
   const metrics=await page.evaluate(()=>{const a=document.querySelector('.plugin-detail-actions').getBoundingClientRect();const h=document.querySelector('.plugin-detail-heading-copy').getBoundingClientRect();const b=document.querySelector('.plugin-detail-back'),bs=getComputedStyle(b);return {width:innerWidth,scroll:document.documentElement.scrollWidth,back:{height:b.getBoundingClientRect().height,minHeight:bs.minHeight,maxHeight:bs.maxHeight,display:bs.display,heightCss:bs.height,buttonHeight:bs.getPropertyValue('--button-height')},actions:{x:a.x,right:a.right,width:a.width},heading:{x:h.x,right:h.right,width:h.width},buttons:[...document.querySelectorAll('.plugin-detail-actions button')].map(b=>({text:b.textContent,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))};});
   assert.ok(metrics.scroll<=width+1,JSON.stringify(metrics));assert.ok(metrics.back.height>=28&&metrics.back.height<60,JSON.stringify(metrics));assert.ok(metrics.actions.right<=width,JSON.stringify(metrics));assert.ok(metrics.buttons.filter(b=>b.text).every(b=>b.width>=65&&b.height>=28),JSON.stringify(metrics));
   await page.screenshot({path:path.join(output,theme+'-'+width+'-long.png'),fullPage:true});log('PASS '+theme+' '+width+'px long content layout '+JSON.stringify(metrics));
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);log('PASS zero browser errors and zero external network attempts; only synthetic IPC used');
  log('HARNESS '+temp);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{log('FAIL '+(e.stack||e));process.exitCode=1;}).finally(()=>fs.writeFile(logFile,logs.join('\n')+'\n'));
