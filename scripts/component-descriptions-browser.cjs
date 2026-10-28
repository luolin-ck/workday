// Actual renderer components with synthetic state; no personal data or external IPC.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.WORKDAY_PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..');
const red = process.argv.includes('--red');
const output = path.join(project, 'output/playwright/component-descriptions');
const logFile = path.join(project, 'test-results/component-descriptions-browser' + (red ? '-red' : '') + '.log');
const checks = [], screenshots = [];
function pass(value) { checks.push(value); console.log('PASS ' + value); }
const harness = String.raw`
import '@mantine/core/styles.css';
import '${project}/src/renderer/style.css';
import React,{useState,useRef,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {PluginsPage} from '${project}/src/renderer/plugins';
import {ContextPicker} from '${project}/src/renderer/ContextPicker';
import {ComponentDraftPreview} from '${project}/src/renderer/ComponentDraftPreview';
import {RuntimeContext} from '${project}/src/renderer/ui';
import {WorkDayProvider} from '${project}/src/renderer/component-theme';
import {defaultAppearance,applyAppearance} from '${project}/src/renderer/appearance';
import {emptyContext} from '${project}/src/shared/types';
applyAppearance(document.documentElement,defaultAppearance());
const entity=id=>({id,version:3,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'});
const long='这是完整的中文描述，支持保留原文并优先展示中文，长内容可以通过提示查看。'.repeat(6);
const skill=(id,name,description,descriptionZh,ownerPluginId=null)=>({...entity(id),name,description,descriptionZh,ownerPluginId,enabled:true,content:'# Fixture\n\nOriginal instructions remain intact.'});
const skills=[skill('zh','中文 Skill','Original skill description.',long),skill('fallback','Fallback Skill','Fallback original skill description.', '   '),skill('owned','包内 Skill','Original owned skill description.','包内技能用于整理材料。','plugin-zh')];
const plugins=[{...entity('plugin-zh'),name:'中文 Plugin',pluginKey:'fixture.zh',description:'Original plugin description.',descriptionZh:'插件中文说明：整理材料并生成可供审阅的结果。',packageVersion:'1.0.0',enabled:true,skillIds:['owned'],mcpIds:[]},{...entity('plugin-fallback'),name:'Fallback Plugin',pluginKey:'fixture.fallback',description:'Fallback original plugin description.',packageVersion:'1.0.0',enabled:true,skillIds:[],mcpIds:[]}];
const initial={gitAccount:null,tasks:[],projects:[],conversations:[],sources:[],knowledge:[],skills,mcpServers:[],grants:[],plugins,drafts:[],schedules:[],runs:[],defaultModel:null,dataDirectory:'/SYNTHETIC',appVersion:'fixture'};
const draft=(kind,descriptionZh)=>({...entity('draft-'+kind),kind:'component',componentKind:kind,conversationId:'fixture-chat',requestId:'fixture-request',name:kind+' fixture',description:'Original '+kind+' installation description.',descriptionZh,source:'Synthetic local materials',status:'pending',components:[{kind,name:kind+' fixture',action:'create'}],files:[],error:null});
function Harness(){
 const [state,setState]=useState(initial),[view,setView]=useState('list'),[context,setContext]=useState(emptyContext());
 const calls=useRef([]),reports=useRef([]);window.__fixture={calls:()=>calls.current,reports:()=>reports.current,state:()=>state};
 async function call(op,input){calls.current.push({op,input:structuredClone(input)});if(op==='skills.save'){setState(previous=>({...previous,skills:previous.skills.map(s=>s.id===input.id?{...s,...input,version:s.version+1}:s)}));return;}throw Error('Unexpected IPC blocked: '+op);}
 return <WorkDayProvider appearance="mono"><RuntimeContext.Provider value={{state,call,refresh:async()=>{},report:t=>reports.current.push(t),go:()=>{},openChat:()=>{},browseProject:()=>{}}}>
 <main style={{padding:12,minHeight:'100vh'}}><nav aria-label="Fixture views">{['list','context','preview'].map(v=><button key={v} onClick={()=>setView(v)}>{v}</button>)}</nav>
 {view==='list'&&<PluginsPage/>}
 {view==='context'&&<ContextPicker value={context} onChange={setContext} owner={{conversationId:'fixture-chat',projectId:null}} disabled={false} onUpload={()=>{}}/>}
 {view==='preview'&&<><ComponentDraftPreview draft={draft('skill','安装技能的中文说明。')} readOnly={false}/><ComponentDraftPreview draft={draft('plugin','安装插件的中文说明。')} readOnly={false}/><ComponentDraftPreview draft={draft('mcp',undefined)} readOnly={false}/></>}
 </main></RuntimeContext.Provider></WorkDayProvider>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Harness/></StrictMode>);
`;
async function main() {
 await fs.mkdir(output,{recursive:true});await fs.mkdir(path.dirname(logFile),{recursive:true});
 const temp=await fs.mkdtemp('/tmp/workday-component-descriptions-ui-');
 await fs.symlink(path.join(project,'node_modules'),path.join(temp,'node_modules'));
 await fs.writeFile(path.join(temp,'index.html'),'<!DOCTYPE html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/harness.tsx"></script></html>');
 await fs.writeFile(path.join(temp,'harness.tsx'),harness);
 const {build}=await import(pathToFileURL(path.join(project,'node_modules/vite/dist/node/index.js')).href);
 await build({configFile:false,root:temp,base:'./',publicDir:false,esbuild:{jsx:'automatic'},build:{outDir:path.join(temp,'dist'),emptyOutDir:true},logLevel:'error'});
 const server=http.createServer(async(req,res)=>{try{let name=new URL(req.url,'http://local').pathname;if(name==='/')name='/index.html';res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(temp,'dist',name)));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();external.push(route.request().url());return route.abort();});
  const shot=async name=>{const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});screenshots.push(file);};
  async function closeModal(name='关闭对话框'){await page.getByRole('button',{name,exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});}
  async function picker(kind){await page.getByRole('button',{name:'添加上下文',exact:true}).click();await page.getByRole('menuitem',{name:kind,exact:true}).click();}
  for(const width of [1500,660]) {
   await page.setViewportSize({width,height:1000});await page.goto(base);
   const zh=page.getByRole('button',{name:'查看 中文 Skill',exact:true});await zh.waitFor();
   const displayed=await zh.locator('.plugin-item-description').innerText();
   assert.match(displayed,/^这是完整的中文描述/,'Skill list must prefer descriptionZh over original description');
   assert.equal(await page.getByRole('button',{name:'查看 Fallback Skill',exact:true}).locator('.plugin-item-description').innerText(),'Fallback original skill description.');
   const rows=await page.locator('.plugin-list-item').evaluateAll(els=>els.map(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('.plugin-item-end').getBoundingClientRect();return {height:a.height,right:a.right,buttonRight:b.right,buttonWidth:b.width};}));
   assert.equal(rows[0].height,rows[1].height);assert.ok(rows.every(r=>r.right<=width&&r.buttonRight<=r.right&&r.buttonWidth>20));
   await zh.hover();await page.getByRole('tooltip').filter({hasText:'这是完整的中文描述'}).waitFor();await shot(width+'-skill-tooltip');
   await zh.click();await page.locator('.skill-detail-description').waitFor();assert.equal(await page.locator('.skill-detail-description').innerText(),displayed);await shot(width+'-skill-detail');await closeModal('关闭详情');
   pass(width+'px Skill list, fixed row height, tooltip, detail, and blank-Chinese fallback');
   await page.getByRole('tab',{name:'Plugin',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'查看 中文 Plugin',exact:true}).locator('.plugin-item-description').innerText(),'插件中文说明：整理材料并生成可供审阅的结果。');
   assert.equal(await page.getByRole('button',{name:'查看 Fallback Plugin',exact:true}).locator('.plugin-item-description').innerText(),'Fallback original plugin description.');
   await page.getByRole('button',{name:'查看 中文 Plugin',exact:true}).click();
   assert.equal(await page.locator('.plugin-detail-description').innerText(),'插件中文说明：整理材料并生成可供审阅的结果。');
   const owned=page.getByRole('button',{name:'查看 Skill 包内 Skill',exact:true});assert.match(await owned.innerText(),/包内技能用于整理材料/);await owned.hover();await page.getByRole('tooltip').filter({hasText:'包内技能用于整理材料'}).waitFor();await page.mouse.move(0,0);
   await shot(width+'-plugin-detail');await owned.click();await page.locator('.skill-detail-description').waitFor();assert.equal(await page.locator('.skill-detail-description').innerText(),'包内技能用于整理材料。');await closeModal('关闭详情');
   await page.getByRole('button',{name:'管理',exact:true}).click();await page.getByRole('dialog',{name:'管理 · 中文 Plugin'}).waitFor();await page.locator('.component-name').hover();await page.getByRole('tooltip').filter({hasText:'包内技能用于整理材料'}).waitFor();await closeModal();
   assert.equal(await page.locator('.plugin-detail-page').count(),1);await page.getByRole('button',{name:'返回插件'}).click();
   pass(width+'px Plugin list/fallback, detail, owned Skill detail/tooltip and management return');
   await page.getByRole('button',{name:'context',exact:true}).click();await picker('Skill');
   assert.match(await page.locator('.context-choice-button').filter({hasText:'中文 Skill'}).innerText(),/这是完整的中文描述/);
   await page.locator('.context-choice-button').filter({hasText:'中文 Skill'}).hover();await page.getByRole('tooltip').filter({hasText:'这是完整的中文描述'}).waitFor();
   await page.getByRole('textbox',{name:'搜索上下文'}).fill('完整的中文描述');assert.equal(await page.locator('.context-choice-button').count(),1);
   await page.getByRole('textbox',{name:'搜索上下文'}).fill('Original skill description');assert.equal(await page.locator('.context-choice-button').count(),2);
   await page.getByRole('textbox',{name:'搜索上下文'}).fill('');await shot(width+'-skill-context');await closeModal();await picker('插件');
   assert.match(await page.locator('.context-choice-button').filter({hasText:'中文 Plugin'}).innerText(),/插件中文说明/);
   await page.getByRole('textbox',{name:'搜索上下文'}).fill('生成可供审阅');assert.equal(await page.locator('.context-choice-button').count(),1);
   await page.getByRole('textbox',{name:'搜索上下文'}).fill('Original plugin description');assert.equal(await page.locator('.context-choice-button').count(),2);await shot(width+'-plugin-context');await closeModal();
   pass(width+'px context selection renders Chinese and searches both original and Chinese descriptions');
   await page.getByRole('button',{name:'preview',exact:true}).click();assert.deepEqual(await page.locator('.component-draft-description').allTextContents(),['安装技能的中文说明。','安装插件的中文说明。','Original mcp installation description.']);await shot(width+'-installation-previews');
   assert.equal(await page.getByRole('button',{name:'确认安装',exact:true}).count(),3);assert.ok(await page.getByRole('button',{name:'确认安装',exact:true}).first().isEnabled());
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));pass(width+'px Skill/Plugin installation drafts prefer Chinese; MCP remains original; confirm controls preserved');
  }
  await page.goto(base);await page.getByRole('button',{name:'更多操作 中文 Skill',exact:true}).click();await page.getByRole('menuitem',{name:'查看 / 编辑',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'原描述',exact:true}).inputValue(),'Original skill description.');
  assert.match(await page.getByRole('textbox',{name:'中文描述',exact:true}).inputValue(),/^这是完整的中文描述/);
  assert.equal(await page.getByRole('textbox',{name:'中文描述',exact:true}).getAttribute('maxlength'),'20000');
  await page.getByRole('textbox',{name:'中文描述',exact:true}).fill('新的中文描述。');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  let saved=await page.evaluate(()=>__fixture.calls().at(-1));assert.equal(saved.op,'skills.save');assert.equal(saved.input.description,'Original skill description.');assert.equal(saved.input.descriptionZh,'新的中文描述。');
  await page.getByRole('button',{name:'更多操作 中文 Skill',exact:true}).click();await page.getByRole('menuitem',{name:'查看 / 编辑',exact:true}).click();await page.getByRole('textbox',{name:'中文描述',exact:true}).fill('');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  saved=await page.evaluate(()=>__fixture.calls().at(-1));assert.equal(saved.input.descriptionZh,'');assert.equal(saved.input.description,'Original skill description.');assert.equal(await page.getByRole('button',{name:'查看 中文 Skill',exact:true}).locator('.plugin-item-description').innerText(),'Original skill description.');
  pass('Editing Chinese preserves original; explicitly clearing Chinese falls back to original');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(await page.evaluate(()=>__fixture.calls().every(c=>c.op==='skills.save')));pass('No browser errors, external network, model requests, or unapproved IPC');
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
}
main().then(async()=>{await fs.mkdir('/tmp/workday-zh-descriptions',{recursive:true});await fs.writeFile('/tmp/workday-zh-descriptions/ui-result.json',JSON.stringify({passed:true,checks,screenshots,logFile},null,2));}).catch(e=>{checks.push('FAIL '+(e.stack||e));console.error(e);process.exitCode=1;}).finally(()=>fs.writeFile(logFile,checks.join('\n')+'\n'));
