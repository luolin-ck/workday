import path from 'node:path';
import type {Skill,Plugin,McpServer} from '../shared/types';
import {readTree,treeHash,skillContent,parsePackageTree,type PackageTree} from './components';

/** Frozen provenance of the three user-approved platform copies. No runtime Codex path access. */
export const PLATFORM_COPY_FINGERPRINTS={
 'skill-creator':{sourceKey:'95962c4b9b0a58658efba53f5fc5b7dfbf42463d5eca24aef049b9c2e7a3c2e5',trees:['a83f28e1c48702d8b2880e2759deecb73093881ca8828f532b4d5765dc035588','4917577a52a4c07e08bc1af65c39448b648b07381adfb04d467eccc1fdb49468']},
 'skill-installer':{sourceKey:'73e944292fa60622b4d5b8ada874ac0f542c4ded1fea0c124523cf02873611a9',trees:['b3345280a5e22a0649a8242912f014a37e280b9db06a9dbdc18c3851ac118adb']},
 plugin:{key:'plugin-management',version:'0.1.0',tree:'0927f57cb1956069cc61138d7540ccc542635cc05fec207defdd0dee9163e8d6',entry:'skills/plugin-management/SKILL.md'}
} as const;
export const PLATFORM_COPY_NOTICE='此平台能力已内置，请从插件页的创建或导入入口开始；旧组件引用不再执行。';
export interface PlatformCopies {skills:Set<string>;plugins:Set<string>;unmatched:string[]}
const storedContent=(content:string,entry:string)=>content.length>40000?'Use workday_skill_read on '+entry+' to read the full workflow in pages.':content;
const sameSkill=(s:Skill,p:{name:string;description:string;content:string},entry:string)=>s.name===p.name&&s.description===p.description&&s.content===storedContent(p.content,entry);
export function knownPlatformSkillTree(tree:PackageTree,sourceKey:string|undefined){const digest=treeHash(tree);return Object.entries(PLATFORM_COPY_FINGERPRINTS).some(([name,value])=>name!=='plugin'&&'sourceKey'in value&&value.sourceKey===sourceKey&&(value.trees as readonly string[]).includes(digest));}
export function knownPlatformPluginTree(tree:PackageTree){return treeHash(tree)===PLATFORM_COPY_FINGERPRINTS.plugin.tree;}
export async function classifyPlatformCopies(directory:string,skills:Skill[],plugins:Plugin[],servers:McpServer[]):Promise<PlatformCopies>{
 const result:PlatformCopies={skills:new Set(),plugins:new Set(),unmatched:[]};
 for(const skill of skills){const f=PLATFORM_COPY_FINGERPRINTS[skill.name as 'skill-creator'|'skill-installer'];if(!f||!('sourceKey'in f)||skill.installation?.sourceKey!==f.sourceKey)continue;
  try{const i=skill.installation;if(!i||skill.ownerPluginId!==null||i.root!=='skills/'+skill.id||i.entry!=='SKILL.md')throw Error('identity');const tree=await readTree(path.join(directory,i.root));if(treeHash(tree)!==i.treeHash||!knownPlatformSkillTree(tree,i.sourceKey)||!sameSkill(skill,skillContent(Buffer.from(tree[i.entry].data,'base64').toString('utf8')),i.entry))throw Error('content');result.skills.add(skill.id);}catch{result.unmatched.push('skill:'+skill.id);}
 }
 const f=PLATFORM_COPY_FINGERPRINTS.plugin;
 for(const plugin of plugins){if(plugin.pluginKey!==f.key)continue;try{
  if(plugin.packageVersion!==f.version||plugin.skillIds.length!==1||plugin.mcpIds.length||servers.some(s=>s.ownerPluginId===plugin.id)||skills.filter(s=>s.ownerPluginId===plugin.id).length!==1)throw Error('identity');
  const tree=await readTree(path.join(directory,'plugins',plugin.id)),data=parsePackageTree(tree),s=skills.find(s=>s.id===plugin.skillIds[0]),i=s?.installation;
  if(!knownPlatformPluginTree(tree)||plugin.fileHash!==f.tree||plugin.name!==data.manifest.name||plugin.description!==data.manifest.description||data.manifest.skills.length!==1||data.manifest.skills[0]!==f.entry||data.servers.length||!s||s.ownerPluginId!==plugin.id||!i||i.root!=='plugins/'+plugin.id||i.entry!==f.entry||i.treeHash!==f.tree||!sameSkill(s,data.skills[0],f.entry))throw Error('content');
  result.plugins.add(plugin.id);result.skills.add(s.id);
 }catch{result.unmatched.push('plugin:'+plugin.id);}}
 return result;
}
