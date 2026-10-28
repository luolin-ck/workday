// Isolated real renderer acceptance: synthetic RuntimeContext and fail-closed IPC.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..');
const output = path.join(project, 'output/playwright/plugin-management');
const baseline = process.argv.includes('--baseline');
const logFile = path.join(project, baseline ? 'test-results/plugin-management-baseline.log' : 'test-results/plugin-management-browser.log');
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
plugins.push({...entity('empty',7),pluginKey:'fixture.empty',name:'Empty Plugin',description:'Empty fixture',packageVersion:'1.0.0',enabled:true,skillIds:[],mcpIds:[]});
const massSkills=Array.from({length:18},(_,i)=>({...entity('bulk-'+i,4),name:'多组件技能 '+i,description:'Source description '+i,descriptionZh:'多组件中文描述 '+i,content:'# Fixture',enabled:true,ownerPluginId:'bulk'}));
const massServers=Array.from({length:8},(_,i)=>({...server,...entity('bulk-mcp-'+i),name:'合成 MCP '+i,ownerPluginId:'bulk'}));
plugins.push({...entity('bulk',7),pluginKey:'fixture.bulk',name:'Many Components',description:'Bulk fixture',packageVersion:'1.0.0',enabled:true,skillIds:massSkills.map(s=>s.id),mcpIds:massServers.map(s=>s.id)});
initial.skills.push(...massSkills);initial.mcpServers.push(...massServers);
skills.find(s=>s.id==='long-s').descriptionZh='完整中文说明，用于验证长标题、提示与操作按钮互不挤占。'.repeat(12);
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
  if(op==='skills.toggle'){update(s=>({...s,skills:s.skills.map(v=>v.id===input.id?{...v,version:v.version+1,enabled:input.enabled}:v)}));return;}
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
 const temp=await fs.mkdtemp('/tmp/workday-plugin-management-browser-');
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
  const close=async()=>{await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});};
  const fresh=async(theme='mono')=>{await page.goto(base+'/?theme='+theme);await page.getByRole('tab',{name:'Plugin',exact:true}).click();};
  const manage=async(name)=>{await page.getByRole('button',{name,exact:true}).click();await page.getByRole('button',{name:'管理',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').evaluate(d=>Promise.all([...d.querySelectorAll('img')].map(i=>i.decode())));};
  const frame=async(name)=>{await page.mouse.move(1,1);await page.screenshot({path:path.join(output,name),fullPage:true});frames.push(name);};
  const geometry=()=>page.getByRole('dialog').evaluate(d=>({width:d.getBoundingClientRect().width,height:d.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth+1,emptyArt:d.querySelectorAll('.empty-art').length,body:d.querySelector('.modal-body').getBoundingClientRect().height,scrollHeight:d.querySelector('.modal-body').scrollHeight,sections:[...d.querySelectorAll('.plugin-management-section')].map(s=>({heading:s.querySelector('h3')?.textContent,rows:s.querySelectorAll('[role=listitem]').length})),empty:[...d.querySelectorAll('.plugin-management-empty')].map(e=>({height:e.getBoundingClientRect().height,text:e.textContent})),rows:[...d.querySelectorAll('.plugin-management-skill')].map(row=>{const name=row.querySelector('.component-name'),buttons=[...row.querySelectorAll('button')],box=name.getBoundingClientRect();return{height:row.getBoundingClientRect().height,nameWidth:box.width,nameRight:box.right,ellipsis:getComputedStyle(name.querySelector('span')).textOverflow,buttons:buttons.map(b=>({left:b.getBoundingClientRect().left,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}))};})}));
  if(baseline){await fresh();await manage('查看 Single Skill');checks.push({scenario:'single-before',geometry:await geometry()});await frame('before-short.png');await close();await page.getByRole('button',{name:'返回插件'}).click();await page.getByRole('tab',{name:'MCP',exact:true}).click();await frame('before-independent-mcp.png');}
  else{
   for(const theme of ['mono','blue'])for(const width of [1500,660]){
    await page.setViewportSize({width,height:1000});
    for(const [scenario,name,skillCount,mcpCount] of [['single','查看 Single Skill',1,0],['empty','查看 Empty Plugin',0,0],['mcp','查看 MCP Only',0,1],['many','查看 Many Components',18,8],['long',null,1,0]]){
     await fresh(theme);await manage(name??('查看 '+await page.evaluate(()=>__fixture.state().plugins.find(p=>p.id==='long').name)));
     const g=await geometry();assert.equal(g.overflow,false);assert.equal(g.emptyArt,0);assert.deepEqual(g.sections.map(s=>s.heading),['Skill'+skillCount,'MCP'+mcpCount]);assert.ok(g.empty.every(e=>e.height<=25));
     if(scenario==='single'||scenario==='empty')assert.ok(g.height<480,JSON.stringify(g));
     if(scenario==='many')assert.ok(g.scrollHeight>g.body&&g.height<=1000,JSON.stringify(g));
     for(const row of g.rows){assert.ok(row.height<=64);assert.equal(row.ellipsis,'ellipsis');assert.ok(row.buttons.every(b=>b.width>=48&&b.height>=28&&b.left>=row.nameRight));}
     if(scenario==='long'){await page.locator('.plugin-management-skill .component-name').hover();await page.getByRole('tooltip').waitFor();const tooltip=await page.getByRole('tooltip').innerText();assert.ok(tooltip.includes('很长的技能名称')&&tooltip.includes('完整中文说明'));}
     await frame(`${scenario}-${theme}-${width}.png`);checks.push({theme,width,scenario,geometry:g});
    }
   }
   await fresh();await manage('查看 Single Skill');await page.getByRole('dialog').getByRole('button',{name:'查看',exact:true}).click();await page.locator('.skill-detail').waitFor();await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.locator('.plugin-management').waitFor();
   await page.getByRole('dialog').getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'启用',exact:true}).waitFor();const toggle=await page.evaluate(()=>__fixture.calls().find(c=>c.op==='skills.toggle'));assert.deepEqual(toggle.input,{id:'one-s',expectedVersion:4,enabled:false});await page.getByRole('dialog').getByRole('button',{name:'启用',exact:true}).click();assert.deepEqual(await page.evaluate(()=>__fixture.calls().filter(c=>c.op==='skills.toggle').at(-1).input),{id:'one-s',expectedVersion:5,enabled:true});await close();checks.push({scenario:'Skill view return and toggle versions'});
   await fresh();await manage('查看 Disabled Plugin');assert.equal(await page.getByRole('dialog').getByRole('button',{name:'停用',exact:true}).isDisabled(),true);await close();
   await fresh();await manage('查看 MCP Only');await page.getByRole('button',{name:'查看 Fixture MCP',exact:true}).click();await page.locator('.mcp-manager .source-detail').waitFor();await frame('mcp-detail.png');await page.getByRole('button',{name:'返回 MCP 列表',exact:true}).click();await page.getByRole('list',{name:'MCP 列表'}).waitFor();await close();checks.push({scenario:'MCP detail and return'});
   await fresh();await page.getByRole('tab',{name:'MCP',exact:true}).click();assert.equal(await page.locator('.empty-art').count(),1);assert.equal(await page.getByRole('button',{name:'新增 MCP',exact:true}).count(),1);await frame('independent-mcp.png');checks.push({scenario:'independent MCP retains full empty state'});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.evaluate(()=>__fixture.calls().some(c=>/mcp\.|chat.send|grants\./.test(c.op))),false);
  const result={passed:true,baseline,checks,frames,errors,external};await fs.writeFile(path.join(output,baseline?'baseline.json':'result.json'),JSON.stringify(result,null,2));log(JSON.stringify({passed:true,baseline,checks:checks.length,frames:frames.length,output}));
 }catch(e){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(e),checks,frames,errors},null,2));throw e;}
 finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{log('FAIL '+(e.stack||e));process.exitCode=1;}).finally(()=>fs.writeFile(logFile,logs.join('\n')+'\n'));
