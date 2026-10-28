import {describe,it,expect} from 'vitest';
import {composerTrigger,consumeComposerTrigger,slashCommands,matchCommand,addContextReference} from '../src/renderer/composer-commands';
import {emptyContext} from '../src/shared/types';
describe('composer trigger boundaries and editing',()=>{
 it('finds @ only at a collapsed caret after whitespace and supports Chinese',()=>{
  expect(composerTrigger('请查看 @资料 后续',7,7)).toEqual({kind:'@',start:4,end:7,query:'资料',text:'@资料'});
  expect(composerTrigger('@资料',1,3)).toBeNull();
  for(const text of ['a@b.com','https://host/@user','src/@scope','@a/b','@a\\b','@a:b','@资料 后续'])expect(composerTrigger(text,text.length,text.length)).toBeNull();
 });
 it('limits slash commands to the start and excludes paths',()=>{
  expect(composerTrigger('  /mod',6,6)?.query).toBe('mod');
  for(const text of ['body /','https://a/b','/usr/bin','./a','../a','C:/foo','/foo bar'])expect(composerTrigger(text,text.length,text.length)).toBeNull();
  expect(matchCommand('上传').map(c=>c.id)).toEqual(['attach']);
  expect(matchCommand('unsupported')).toEqual([]);
  expect(slashCommands.map(command=>command.id)).toEqual(['attach','skill','plugin','model','new']);
  expect(matchCommand('context')).toEqual([]);
  expect(matchCommand('mcp')).toEqual([]);
 });
 it('consumes only the trigger range and refuses a changed draft',()=>{
  const text='前文 @参考 后文',trigger=composerTrigger(text,6,6)!;
  expect(consumeComposerTrigger(text,trigger)).toEqual({text:'前文  后文',caret:3});
  expect(consumeComposerTrigger('changed',trigger)).toBeNull();
 });
});
describe('context reference selection',()=>{
 it('deduplicates knowledge and conversation references, enforces three chats',()=>{
  let value=emptyContext();
  value=addContextReference(value,{kind:'knowledge',id:'k',version:2});
  expect(addContextReference(value,{kind:'knowledge',id:'k',version:2}).knowledgeRefs).toEqual([{id:'k',version:2}]);
  for(const id of ['a','b','c'])value=addContextReference(value,{kind:'conversation',id,version:1,digest:id});
  expect(addContextReference(value,{kind:'conversation',id:'a',version:1,digest:'a'}).conversationRefs).toHaveLength(3);
  expect(()=>addContextReference(value,{kind:'conversation',id:'d',version:1,digest:'d'})).toThrow('最多引用 3 个对话');
 });
 it('keeps a manually edited knowledge excerpt when the same reference is selected again',()=>{
  const value={...emptyContext(),knowledgeRefs:[{id:'k',version:2,excerpt:'Only this selected passage'}]};
  expect(addContextReference(value,{kind:'knowledge',id:'k',version:2})).toBe(value);
  expect(addContextReference(value,{kind:'knowledge',id:'k',version:3}).knowledgeRefs).toEqual([{id:'k',version:3}]);
 });
 it('replaces Skill while preserving only unrelated plugin capabilities',()=>{
  const value={...emptyContext(),skillRef:{id:'old',version:1},pluginRefs:[{id:'p',version:1,skillId:'old',mcpRefs:[{id:'m',configVersion:1,capabilityNames:['read']}]},{id:'q',version:1,skillId:'old',mcpRefs:[]}]};
  const next=addContextReference(value,{kind:'skill',id:'new',version:2});
  expect(next.skillRef).toEqual({id:'new',version:2});expect(next.pluginRefs).toEqual([{id:'p',version:1,skillId:null,mcpRefs:value.pluginRefs[0].mcpRefs}]);
 });
});
