import {ActionIcon,Button,Checkbox,Menu,TextInput,UnstyledButton} from '@mantine/core';
import {useEffect,useRef,useState,useImperativeHandle,type Ref} from 'react';
import {addContextReference} from './composer-commands';
import type {ContextOwner,ConversationReference} from '../shared/chat-context';
import type {ContextSelection,Plugin,PluginRef} from '../shared/types';
import {Icon,type IconName} from './icons';
import {Hint,Modal,useApp} from './ui';
import {takePluginPicker,subscribePluginPicker,preparePluginManagement} from './plugin-trial';
import {componentDescription} from '../shared/component-description';
function compactPlugins(refs:PluginRef[]){return refs.filter(p=>p.skillId||p.mcpRefs.some(m=>m.capabilityNames.length));}
export function withoutPlugin(value:ContextSelection,id:string){const owned=value.pluginRefs?.find(p=>p.id===id);if(!owned)return value;return {...value,skillRef:owned.skillId===value.skillRef?.id?null:value.skillRef,mcpRefs:value.mcpRefs.map(m=>({...m,capabilityNames:m.capabilityNames.filter(name=>!owned.mcpRefs.some(r=>r.id===m.id&&r.capabilityNames.includes(name)))})).filter(m=>m.capabilityNames.length),pluginRefs:value.pluginRefs?.filter(p=>p.id!==id)};}
export type ContextPickerPanel='conversations'|'skills'|'plugins';
export interface ContextPickerController {open:(panel:ContextPickerPanel,pluginId?:string)=>void;upload:()=>void}
export function ContextPicker({value,onChange,owner,disabled,onUpload,controllerRef,scopeKey,management=false}:{value:ContextSelection;onChange:(value:ContextSelection)=>void;owner:ContextOwner;disabled:boolean;onUpload:()=>void;controllerRef?:Ref<ContextPickerController>;scopeKey?:string;management?:boolean}){
 const {state,call,report,go}=useApp();const [panel,setPanel]=useState<'conversations'|'skills'|'plugins'|null>(null),[query,setQuery]=useState(''),[references,setReferences]=useState<ConversationReference[]>([]),[selectedPlugin,setSelectedPlugin]=useState<string|null>(null),[pluginSkill,setPluginSkill]=useState<string|null>(null),[pluginTools,setPluginTools]=useState<Record<string,string[]>>({});
 const scope=JSON.stringify([owner,scopeKey]),latest=useRef({scope,value,onChange,disabled,alive:true});latest.current={scope,value,onChange,disabled,alive:true};
 const permitted=()=>latest.current.alive&&latest.current.scope===scope&&!latest.current.disabled;
 useEffect(()=>{latest.current.alive=true;return()=>{latest.current.alive=false;};},[]);useEffect(()=>{setPanel(null);setQuery('');setReferences([]);setSelectedPlugin(null);},[scope,disabled]);
 const initialPicker=useRef<{scope:string;pluginId:string}|null>(null);
 const pickerRuntime=useRef({plugins:state.plugins,report});pickerRuntime.current={plugins:state.plugins,report};
 useEffect(()=>{
  function showIntent(replay=false){
   if(!permitted())return;
   const requested=takePluginPicker(owner.conversationId);
   if(requested)initialPicker.current={scope,pluginId:requested};
   else if(initialPicker.current?.scope!==scope)initialPicker.current=null;
   const intent=requested||replay?initialPicker.current:null;
   if(!intent)return;
   if(!pickerRuntime.current.plugins.some(p=>p.id===intent.pluginId&&p.enabled)){pickerRuntime.current.report('插件已停用或移除。');return;}
   setQuery('');setPanel('plugins');setSelectedPlugin(intent.pluginId);setPluginSkill(null);setPluginTools({});
  }
  const unsubscribe=subscribePluginPicker(owner.conversationId,()=>showIntent());
  showIntent(true);
  return unsubscribe;
 },[scope]);
 useEffect(()=>{if(panel!=='conversations')return;setReferences([]);let active=true;void call('context.conversations',{owner,query}).then(items=>{if(active&&latest.current.scope===scope)setReferences(items);}).catch(e=>{if(active&&permitted())report(e.message);});return()=>{active=false;};},[panel,query,scope]);

 function open(panel:ContextPickerPanel,pluginId?:string){
  if(management&&panel!=='conversations'){report('管理对话不能混合普通组件，请新建普通聊天。');return;}
  if(!permitted())return;
  if(pluginId&&!state.plugins.some(p=>p.id===pluginId&&p.enabled)){report('插件已停用或移除。');return;}
  setQuery('');setSelectedPlugin(pluginId??null);setPluginSkill(null);setPluginTools({});setPanel(panel);
 }
 useImperativeHandle(controllerRef,()=>({open,upload:()=>{if(permitted())onUpload();}}));
 const grants=state.grants.filter(g=>!g.revoked&&g.capabilityType==='tool'&&g.scopeType==='conversation'&&g.scopeId===owner.conversationId);
 const available=(plugin:Plugin)=>state.mcpServers.filter(m=>plugin.mcpIds.includes(m.id)&&m.ownerPluginId===plugin.id&&m.enabled).map(m=>({...m,allowed:m.tools.filter(t=>grants.some(g=>g.mcpId===m.id&&g.configVersion===m.configVersion&&g.capabilityName===t.name))}));
 function usePlugin(plugin:Plugin){
  if(!permitted()||!plugin.enabled||!state.plugins.some(p=>p.id===plugin.id&&p.version===plugin.version&&p.enabled))return;
  if(pluginSkill&&!state.skills.some(s=>s.id===pluginSkill&&s.enabled&&s.ownerPluginId===plugin.id&&plugin.skillIds.includes(s.id))){report('所选 Skill 已变化，请重新选择。');return;}
  for(const [serverId,names] of Object.entries(pluginTools))if(names.some(name=>!available(plugin).some(m=>m.id===serverId&&m.allowed.some(t=>t.name===name)))){report('工具授权已变化，请重新选择。');return;}
  let next=(value.pluginRefs??[]).some(p=>p.id===plugin.id)?withoutPlugin(value,plugin.id):value;const added:PluginRef={id:plugin.id,version:plugin.version,skillId:pluginSkill&&next.skillRef?.id!==pluginSkill?pluginSkill:null,mcpRefs:[]};if(pluginSkill){const skill=state.skills.find(s=>s.id===pluginSkill)!;next={...next,skillRef:{id:skill.id,version:skill.version},pluginRefs:compactPlugins((next.pluginRefs??[]).map(p=>({...p,skillId:p.skillId===skill.id?p.skillId:null})))};}for(const server of available(plugin)){const names=pluginTools[server.id]??[];if(!names.length)continue;const previous=next.mcpRefs.find(m=>m.id===server.id);const introduced=names.filter(name=>!previous?.capabilityNames.includes(name));if(introduced.length)added.mcpRefs.push({id:server.id,configVersion:server.configVersion,capabilityNames:introduced});next={...next,mcpRefs:[...next.mcpRefs.filter(m=>m.id!==server.id),{id:server.id,configVersion:server.configVersion,capabilityNames:[...new Set([...(previous?.capabilityNames??[]),...names])]}]};}next={...next,pluginRefs:compactPlugins([...(next.pluginRefs??[]),added])};onChange(next);setPanel(null);}
 const chips:{key:string;label:string;icon:IconName;remove:()=>void}[]=[];

 for(const ref of value.conversationRefs??[])chips.push({key:'chat'+ref.id,label:state.conversations.find(c=>c.id===ref.id)?.title??'引用聊天已移除',icon:'messages-square',remove:()=>onChange({...value,conversationRefs:value.conversationRefs?.filter(v=>v.id!==ref.id)})});
 for(const ref of value.pluginRefs??[])chips.push({key:'plugin'+ref.id,label:state.plugins.find(p=>p.id===ref.id)?.name??'插件已移除',icon:'puzzle',remove:()=>onChange(withoutPlugin(value,ref.id))});
 if(value.skillRef&&!value.pluginRefs?.some(p=>p.skillId===value.skillRef?.id))chips.push({key:'skill'+value.skillRef.id,label:state.skills.find(s=>s.id===value.skillRef?.id)?.name??'Skill 已移除',icon:'sparkles',remove:()=>onChange({...value,skillRef:null})});
 for(const id of value.taskIds)chips.push({key:'task'+id,label:state.tasks.find(t=>t.id===id)?.title??'待办已移除',icon:'square',remove:()=>onChange({...value,taskIds:value.taskIds.filter(t=>t!==id)})});
 for(const ref of value.knowledgeRefs)chips.push({key:'knowledge'+ref.id,label:state.knowledge.find(k=>k.id===ref.id)?.name??'资料已移除',icon:'library-big',remove:()=>onChange({...value,knowledgeRefs:value.knowledgeRefs.filter(k=>k.id!==ref.id)})});
 for(const ref of value.mcpRefs)for(const name of ref.capabilityNames){
  if(value.pluginRefs?.some(p=>p.mcpRefs.some(m=>m.id===ref.id&&m.capabilityNames.includes(name))))continue;
  chips.push({key:JSON.stringify(['mcp',ref.id,name]),label:`${state.mcpServers.find(m=>m.id===ref.id)?.name??'MCP 已移除'} · ${name}`,icon:'settings',remove:()=>onChange({...value,mcpRefs:value.mcpRefs.map(m=>m.id===ref.id?{...m,capabilityNames:m.capabilityNames.filter(n=>n!==name)}:m).filter(m=>m.capabilityNames.length)})});
 }
 const matchesDescription=(component:{name:string;description:string;descriptionZh?:string})=>[component.name,component.description,component.descriptionZh??''].some(text=>text.toLowerCase().includes(query.toLowerCase()));
 const skills=state.skills.filter(s=>s.enabled&&s.ownerPluginId===null&&matchesDescription(s));
 const plugins=state.plugins.filter(p=>p.enabled&&matchesDescription(p));
 const plugin=state.plugins.find(p=>p.id===selectedPlugin&&p.enabled);
 return <>
 <div className="context-controls">
 <Menu position="top-start" withinPortal><Menu.Target><UnstyledButton type="button" className="composer-context" aria-label="添加上下文" disabled={disabled}><Icon name="plus"/></UnstyledButton></Menu.Target><Menu.Dropdown>
 <Menu.Item leftSection={<Icon name="paperclip" size="sm"/>} onClick={()=>{if(permitted())onUpload();}}>上传附件</Menu.Item>
 <Menu.Item leftSection={<Icon name="messages-square" size="sm"/>} onClick={()=>open('conversations')}>选择对话</Menu.Item>
 <Menu.Item disabled={management} leftSection={<Icon name="sparkles" size="sm"/>} onClick={()=>open('skills')}>Skill</Menu.Item>
 <Menu.Item disabled={management} leftSection={<Icon name="puzzle" size="sm"/>} onClick={()=>open('plugins')}>插件</Menu.Item></Menu.Dropdown></Menu>
 </div>
 {chips.length>0&&<div className="context-chips" aria-label="已选上下文">{chips.map(chip=><span className="context-chip" key={chip.key}><Icon name={chip.icon} size="sm"/><Hint label={chip.label}><span className="context-chip-label">{chip.label}</span></Hint><ActionIcon variant="subtle" type="button" size="var(--size-actionSmall)" aria-label={`移除上下文 ${chip.label}`} disabled={disabled} onClick={chip.remove}><Icon name="x" size="xs"/></ActionIcon></span>)}</div>}
 {panel&&<Modal title={panel==='conversations'?'选择对话':panel==='skills'?'选择 Skill':'选择插件组件'} onClose={()=>setPanel(null)} wide>
 <fieldset disabled={disabled} className="context-picker-fields"><TextInput autoFocus aria-label="搜索上下文" placeholder={panel==='conversations'?'搜索对话标题':'搜索名称或描述'} value={query} onChange={e=>setQuery(e.target.value)}/>
 <div className="context-choices">
 {panel==='conversations'&&<><p className="muted">最近 50 个匹配聊天，搜索标题可定位更多。</p>{references.map(ref=><div className="context-choice" key={ref.id}><Checkbox label={<><strong>{ref.title}</strong><small>{ref.projectName}</small></>} checked={!!value.conversationRefs?.some(v=>v.id===ref.id)} onChange={e=>{if(!permitted())return;const refs=value.conversationRefs??[];if(e.target.checked&&refs.length>=3){report('最多引用 3 个对话。');return;}onChange({...value,conversationRefs:e.target.checked?[...refs,{id:ref.id,version:ref.version,digest:ref.digest}]:refs.filter(v=>v.id!==ref.id)});}}/><details><summary>预览文本</summary><pre>{ref.preview}</pre></details></div>)}{!references.length&&<p className="muted">没有可引用的完整对话；仅支持未归档、无生成中请求且不超过 30000 字的最近 20 条文本。</p>}</>}
 {panel==='skills'&&<>{value.skillRef&&<p className="muted">选择另一项将替换当前 Skill；一次使用一个。</p>}{skills.map(skill=><Hint key={skill.id} label={[skill.name,componentDescription(skill)].filter(Boolean).join("\n")} interactive><UnstyledButton className="context-choice context-choice-button" onClick={()=>{if(!permitted())return;onChange(addContextReference(value,{kind:'skill',id:skill.id,version:skill.version}));setPanel(null);}}><Icon name="sparkles"/><span><strong>{skill.name}</strong><small>{skill.installation?'已安装指令与资源，依赖未验证 · ':''}{componentDescription(skill)||`v${skill.version}`}</small></span>{value.skillRef?.id===skill.id&&<Icon name="check" size="sm"/>}</UnstyledButton></Hint>)}{!skills.length&&<p className="muted">暂无启用的 Skill</p>}</>}
 {panel==='plugins'&&<>{plugins.map(p=><Hint key={p.id} label={[p.name,componentDescription(p)].filter(Boolean).join("\n")} interactive><UnstyledButton type="button" className={`context-choice context-choice-button ${selectedPlugin===p.id?'selected':''}`} onClick={()=>{setSelectedPlugin(p.id);setPluginSkill(null);setPluginTools({});}}><Icon name="puzzle"/><span><strong>{p.name}</strong><small>{componentDescription(p)||`v${p.packageVersion}`}</small></span><Icon name="chevron-right" size="sm"/></UnstyledButton></Hint>)}{!plugins.length&&<p className="muted">暂无启用的插件</p>}{plugin&&<div className="context-plugin-components"><strong>{plugin.name} · 选择具体组件</strong>{state.skills.filter(s=>plugin.skillIds.includes(s.id)&&s.enabled&&s.ownerPluginId===plugin.id).map(s=><Checkbox key={s.id} label={`${s.name} · 依赖未验证${value.skillRef&&value.skillRef.id!==s.id?'（替换当前 Skill）':''}`} checked={pluginSkill===s.id} onChange={e=>setPluginSkill(e.target.checked?s.id:null)}/>)}{available(plugin).map(m=><div key={m.id}>{m.allowed.map(t=><Checkbox key={t.name} label={`${m.name} · ${t.name}`} checked={pluginTools[m.id]?.includes(t.name)??false} onChange={e=>setPluginTools({...pluginTools,[m.id]:e.target.checked?[...(pluginTools[m.id]??[]),t.name]:(pluginTools[m.id]??[]).filter(n=>n!==t.name)})}/>)}</div>)}{!available(plugin).some(m=>m.allowed.length)&&plugin.mcpIds.length>0&&<p className="muted">此聊天暂无已授权的插件 MCP 能力。<Button type="button" variant="subtle" onClick={()=>{preparePluginManagement(plugin.id,owner.conversationId);setPanel(null);go('插件');}}>前往插件页配置</Button></p>}<Button type="button" className="primary" disabled={!pluginSkill&&!Object.values(pluginTools).some(names=>names.length)} onClick={()=>usePlugin(plugin)}>添加所选组件</Button></div>}</>}
 </div></fieldset>
 </Modal>}
 </>;
}
