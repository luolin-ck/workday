import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ComponentKind,ComponentIntent,Conversation} from '../../shared/types';
import {skillContent} from '../plugin/components';
import {requireThat,strictUtf8} from '../validation';

/** Private application instructions. These are never installed or selected as user Skills. */
export interface PlatformCapability {key:string;kind:ComponentKind;intent:ComponentIntent;version:number;name:string;description:string;instructions:string;files:Record<string,string>;digest:string}
const kinds:ComponentKind[]=['skill','mcp','plugin'];
/** Read actual package bytes on each authorization check so changed resources revoke old bindings. */
export function loadPlatformCapability(root:string,kind:ComponentKind,intent:ComponentIntent):PlatformCapability {
 const files:Record<string,string>={};
 function visit(relative=''){
  const directory=path.join(root,relative);requireThat(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'系统技能目录无效');
  for(const entry of readdirSync(directory).sort()){
   const ref=relative?relative+'/'+entry:entry,file=path.join(root,ref),stat=lstatSync(file);
   requireThat(!stat.isSymbolicLink(),'系统技能不允许符号链接');
   if(stat.isDirectory())visit(ref);else {requireThat(stat.isFile(),'系统技能资源无效');files[ref]=strictUtf8(readFileSync(file));}
  }
 }
 visit();const skill=skillContent(files['SKILL.md']??'');
 requireThat(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)&&skill.name.length<=64&&skill.name===path.basename(root),'系统技能名称须匹配包目录');
 requireThat(skill.description.length<=1024&&skill.content.trim().length>0,'系统技能描述或工作流无效');
 for(const [ref,text] of Object.entries(files))if(ref.endsWith('.md'))for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
  const target=match[1].split('#')[0];if(!target||/^https?:\/\//.test(target))continue;
  requireThat(!target.includes('\\')&&!path.posix.isAbsolute(target)&&!target.split('/').includes('..'),'系统技能引用须在包内');
  const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(ref),target));requireThat(Object.hasOwn(files,resolved),'系统技能引用不存在：'+resolved);
 }
 return {key:'workday.components.'+skill.name,kind,intent,version:2,name:skill.name,description:skill.description,instructions:skill.content,files,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
export function platformCapability(kind:ComponentKind,intent:ComponentIntent='create'):PlatformCapability {
 requireThat(kinds.includes(kind)&&(intent==='create'||intent==='import'),'系统技能入口无效');
 const name=kind==='skill'?'skill-'+(intent==='create'?'creator':'installer'):kind+'-manager';
 return loadPlatformCapability(path.join(__dirname,'..',kind,'capability',name),kind,intent);
}
/** Read/reject compatibility only; no legacy ID resolves to a Skill or grants a session. */
export const legacyComponentKind=(id:string|null|undefined):ComponentKind|undefined=>kinds.find((_,i)=>id===`b17d0000-0000-4000-8000-00000000000${i+1}`);
export function componentMode(c:Pick<Conversation,'context'|'componentMode'>):{kind:ComponentKind;intent:ComponentIntent}|undefined {
 if(c.componentMode)return c.componentMode;
 const kind=legacyComponentKind(c.context.skillRef?.id);return kind?{kind,intent:'create'}:undefined;
}
