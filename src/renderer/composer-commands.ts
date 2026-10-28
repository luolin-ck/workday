import type {ContextSelection} from '../shared/types';
import type {IconName} from './icons';
export interface ComposerTrigger {kind:'@'|'/';start:number;end:number;query:string;text:string}
/** Only the token ending at a collapsed caret is eligible; surrounding text stays untouched. */
export function composerTrigger(text:string,start:number,end:number):ComposerTrigger|null {
  if(start!==end||start<0||start>text.length)return null;
  const before=text.slice(0,start);
  const mention=/(?:^|\s)(@[^\s@/\\:]*)$/u.exec(before);
  if(mention)return {kind:'@',start:start-mention[1].length,end:start,query:mention[1].slice(1),text:mention[1]};
  const command=/^\s*(\/[\p{L}\p{N}_-]*)$/u.exec(before);
  return command?{kind:'/',start:start-command[1].length,end:start,query:command[1].slice(1),text:command[1]}:null;
}
export function consumeComposerTrigger(text:string,trigger:ComposerTrigger) {
  if(text.slice(trigger.start,trigger.end)!==trigger.text)return null;
  return {text:text.slice(0,trigger.start)+text.slice(trigger.end),caret:trigger.start};
}
export const slashCommands:{id:'attach'|'skill'|'plugin'|'model'|'new';title:string;description:string;icon:IconName}[]=[
  {id:'attach',title:'上传附件',description:'添加图片、PDF 或文本文件',icon:'paperclip'},
  {id:'skill',title:'选择 Skill',description:'选用已启用的工作方法',icon:'sparkles'},
  {id:'plugin',title:'选择插件',description:'选择插件中的具体组件',icon:'puzzle'},
  {id:'model',title:'切换模型',description:'更改当前聊天使用的模型',icon:'circle'},
  {id:'new',title:'新建聊天',description:'在当前项目中开始新聊天',icon:'pencil'}
];
export type ComposerCommand=typeof slashCommands[number]['id'];
export const matchCommand=(query:string)=>slashCommands.filter(c=>[c.id,c.title,c.description].some(text=>text.toLowerCase().includes(query.toLowerCase())));
export type ContextReference={kind:'skill';id:string;version:number}|{kind:'knowledge';id:string;version:number}|{kind:'conversation';id:string;version:number;digest:string};
export function addContextReference(value:ContextSelection,ref:ContextReference):ContextSelection {
  if(ref.kind==='skill')return {...value,skillRef:{id:ref.id,version:ref.version},pluginRefs:(value.pluginRefs??[]).map(p=>({...p,skillId:null})).filter(p=>p.mcpRefs.some(m=>m.capabilityNames.length))};
  if(ref.kind==='knowledge'){
    if(value.knowledgeRefs.some(r=>r.id===ref.id&&r.version===ref.version))return value;
    return {...value,knowledgeRefs:[...value.knowledgeRefs.filter(r=>r.id!==ref.id),{id:ref.id,version:ref.version}]};
  }
  const previous=value.conversationRefs??[];
  if(!previous.some(r=>r.id===ref.id)&&previous.length>=3)throw Error('最多引用 3 个对话。');
  return {...value,conversationRefs:[...previous.filter(r=>r.id!==ref.id),{id:ref.id,version:ref.version,digest:ref.digest}]};
}
