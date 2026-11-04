import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as capabilities from '../../src/main/platform/platform-capabilities';
import {ComponentAuthoring} from '../../src/main/platform/component-authoring';

const clean:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())await fn();});
const load=(root:string)=>(capabilities as any).loadPlatformCapability(root,'skill','create');
const valid='---\nname: fixture-skill\ndescription: Create a synthetic workflow for an explicitly requested local task.\n---\n# Workflow\nRead [format](references/format.md), then prepare a proposal.\n';
async function fixture(content=valid){const parent=await fs.mkdtemp(path.join(os.tmpdir(),'wd-system-skill-')),root=path.join(parent,'fixture-skill');await fs.mkdir(path.join(root,'references'),{recursive:true});await fs.writeFile(path.join(root,'SKILL.md'),content);await fs.writeFile(path.join(root,'references/format.md'),'# Format\nKeep the supplied resources.\n');clean.push(()=>fs.rm(parent,{recursive:true,force:true}));return root;}

it('selects self-contained standard packages for all six management entry points',()=>{
 const seen=new Set<string>();
 for(const kind of ['skill','mcp','plugin'] as const)for(const intent of ['create','import'] as const){
  const capability=capabilities.platformCapability(kind,intent);
  expect(capability.name).toBe(kind==='skill'?'skill-'+(intent==='create'?'creator':'installer'):kind+'-manager');
  expect(capability.key).toBe('workday.components.'+capability.name);
  expect(capability.description.length).toBeGreaterThan(30);
  expect(capability.files['SKILL.md']).toMatch(/^---\nname:/);
  expect(capability.files['references/tools.md']).toBeTruthy();
  expect(capability.files['instructions.md']).toBeUndefined();
  expect(capability.instructions).not.toMatch(/^---/);
  seen.add(capability.name);
 }
 expect(seen.size).toBe(4);
 expect(capabilities.platformCapability('skill','create').digest).not.toBe(capabilities.platformCapability('skill','import').digest);
});

it.each([
 ['missing frontmatter','# Missing metadata'],
 ['missing description','---\nname: fixture-skill\n---\nWorkflow'],
 ['invalid name',valid.replace('fixture-skill','Fixture Skill')],
 ['mismatched directory',valid.replace('fixture-skill','other-skill')],
 ['empty body','---\nname: fixture-skill\ndescription: Create a synthetic workflow for local tasks.\n---\n'],
 ['overlong description',valid.replace('Create a synthetic workflow for an explicitly requested local task.','x'.repeat(1025))],
 ['YAML alias','---\nname: fixture-skill\ndescription: &description Workflow\nmetadata:\n  description_zh: *description\n---\nWorkflow']
])('rejects a standard package with %s',async(_label,content)=>{const root=await fixture(content);expect(()=>load(root)).toThrow();});

it('rejects missing and escaping references and symlinked resources',async()=>{
 const root=await fixture();await fs.rm(path.join(root,'references/format.md'));expect(()=>load(root)).toThrow();
 await fs.writeFile(path.join(root,'SKILL.md'),valid.replace('references/format.md','../outside.md'));expect(()=>load(root)).toThrow();
 await fs.writeFile(path.join(root,'SKILL.md'),valid);await fs.symlink(path.join(root,'SKILL.md'),path.join(root,'references/format.md'));expect(()=>load(root)).toThrow();
});

it('binds all actual package resources into the digest',async()=>{
 const root=await fixture(),first=load(root);expect(first.files['references/format.md']).toContain('supplied resources');
 await fs.appendFile(path.join(root,'references/format.md'),'New format.\n');expect(load(root).digest).not.toBe(first.digest);
 await fs.writeFile(path.join(root,'references/extra.md'),'Supporting detail.');expect(load(root).files['references/extra.md']).toBe('Supporting detail.');
});

it('reads the selected builtin package and revokes an old session after real file changes',async()=>{
 const root=await fixture(),authoring=new ComponentAuthoring(path.dirname(root));
 vi.spyOn(capabilities,'platformCapability').mockImplementation((kind,intent)=>({...load(root),kind,intent}));
 const conversation:any={id:'fixture',componentMode:{kind:'skill',intent:'create'},context:{skillRef:null,mcpRefs:[],pluginRefs:[]},projectId:null,archived:false};
 const binding=authoring.start(conversation.id,'skill','create');
 expect(()=>authoring.check(conversation,{...binding,kind:'mcp'})).toThrow('管理会话绑定已失效');
 expect(()=>authoring.check(conversation,{...binding,intent:'import'})).toThrow('管理会话绑定已失效');
 const read=await authoring.read(conversation,binding,{source:'builtin',path:'references/format.md'});if(!('text'in read))throw new Error('Expected file text');expect(read.text).toContain('supplied resources');
 await fs.appendFile(path.join(root,'references/format.md'),'Changed after start.\n');
 expect(()=>authoring.binding(conversation)).toThrow('管理对话已失效');
 await expect(authoring.read(conversation,binding,{source:'builtin',path:'SKILL.md'})).rejects.toThrow('管理对话已失效');
 await authoring.close();
});
