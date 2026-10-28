import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as components from '../src/main/components';

const roots:string[]=[];
async function directory(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'workday-package-'));roots.push(root);return root;}
async function put(root:string,file:string,value:string|Buffer,mode?:number){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),value);if(mode!==undefined)await fs.chmod(path.join(root,file),mode);}
const entry='---\nname: summary\ndescription: A summary workflow\n---\nRead [reference](references/guide.md) and run `scripts/report.py` only after approval.';
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const pluginSchema='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

describe('portable Skill and Plugin packages',()=>{
 it('copies a whole standalone directory with binary assets and executable modes without flattening references',async()=>{
  const root=await directory();await put(root,'SKILL.md',entry);await put(root,'references/guide.md','REFERENCE');await put(root,'scripts/report.py','print("hello")',0o755);await put(root,'assets/image.png',Buffer.from([0,255,128,10]));
  const skill=await components.readSkill(path.join(root,'SKILL.md')) as any;
  expect(skill.content).not.toContain('[资料');expect(skill.entry).toBe('SKILL.md');expect(skill.tree['assets/image.png']).toEqual({encoding:'base64',data:'AP+ACg==',mode:0o644,sha256:digest(Buffer.from([0,255,128,10]))});expect(skill.tree['scripts/report.py'].mode).toBe(0o755);
  const installed=await directory();await (components as any).writeTree(installed,skill.tree);await fs.rm(root,{recursive:true});expect(await fs.readFile(path.join(installed,'references/guide.md'),'utf8')).toBe('REFERENCE');expect((await fs.stat(path.join(installed,'scripts/report.py'))).mode&0o777).toBe(0o755);
 });
 it('parses quoted, folded and literal YAML with CRLF and retains long entry bodies',async()=>{
  const parsed=components.skillContent('---\r\nname: "summary: compact"\r\ndescription: >-\r\n  A folded\r\n  description\r\nmetadata:\r\n  label: "safe"\r\n---\r\nBODY');expect(parsed).toMatchObject({name:'summary: compact',description:'A folded description',content:'BODY'});
  expect(components.skillContent('---\nname: summary\ndescription: |\n  First\n  Second\n---\nBody').description).toBe('First\nSecond\n');
  const root=await directory();await put(root,'SKILL.md','---\nname: long\ndescription: Long entry\n---\n'+'L'.repeat(90000));expect((await components.readSkill(path.join(root,'SKILL.md'))).content).toHaveLength(90000);
 });
 it.each(['name: &a summary\ndescription: *a','name: !!js/function summary\ndescription: bad','[name, description]','name: one\nname: two\ndescription: duplicate'])('rejects unsafe or invalid YAML %s',header=>{expect(()=>components.skillContent('---\n'+header+'\n---\nbody')).toThrow();});
 it('recognizes a real legacy package despite a name-only root plugin.json and preserves genuine names',async()=>{
  const root=await directory();await put(root,'plugin.json',JSON.stringify({name:'compat-stub'}));await put(root,'.codex-plugin/plugin.json',JSON.stringify({name:'workflow',version:'5.3.2',skills:'./skills/',hooks:'./hooks/config.json',interface:{displayName:'Workflow'}}));await put(root,'skills/summary/SKILL.md',entry);await put(root,'hooks/config.json','{}');await put(root,'LICENSE','MIT');
  const pkg=await components.readPackage(root) as any;expect(pkg.format).toBe('legacy');expect(pkg.manifest).toMatchObject({id:'workflow',name:'Workflow',version:'5.3.2'});expect(pkg.skills[0].name).toBe('summary');expect(pkg.skills[0].path).toBe('skills/summary/SKILL.md');expect(pkg.declarations.hooks).toBe(true);expect(pkg.tree.LICENSE).toBeDefined();
 });
 it('discovers portable fixed paths and replaces the entire legacy overlay with the inline overlay',async()=>{
  const root=await directory();await put(root,'plugin.json',JSON.stringify({$schema:pluginSchema,name:'portable',version:'1.2.3',extensions:{'com.openai':{interface:{displayName:'Portable'}}}}));await put(root,'.codex-plugin/plugin.json',JSON.stringify({name:'wrong',version:'8.0.0',apps:'./missing-apps.json',hooks:'./missing-hooks.json',skills:'./wrong'}));await put(root,'skills/summary/SKILL.md',entry);await put(root,'mcp.json',JSON.stringify({$schema:mcpSchema,mcpServers:{remote:{type:'streamable-http',url:'https://example.com/mcp'}}}));
  const pkg=await components.readPackage(root);expect(pkg.format).toBe('portable');expect(pkg.manifest).toMatchObject({id:'portable',name:'Portable',version:'1.2.3'});expect(pkg.declarations).toEqual({apps:[],hooks:false});expect(pkg.skills[0].path).toBe('skills/summary/SKILL.md');expect(pkg.servers[0]).toMatchObject({name:'remote',transport:'http',url:'https://example.com/mcp'});
 });
 it('validates the recognized portable schema and rejects unknown schemas instead of accepting a malformed package',async()=>{
  const root=await directory();await put(root,'plugin.json',JSON.stringify({$schema:pluginSchema,name:'portable'}));expect((await components.readPackage(root)).manifest.version).toBe('0.0.0');await put(root,'plugin.json',JSON.stringify({$schema:pluginSchema,name:'portable',version:'release-autumn'}));expect((await components.readPackage(root)).manifest.version).toBe('release-autumn');
  for(const value of [{$schema:pluginSchema,name:'not--valid'},{$schema:pluginSchema,name:'portable',unexpected:true},{$schema:pluginSchema,name:'portable',author:{name:'A',token:'secret'}},{$schema:'https://elsewhere.example/schema',name:'portable'}]){await put(root,'plugin.json',JSON.stringify(value));await expect(components.readPackage(root)).rejects.toThrow();}
 });
 it('keeps ordinary HTTP headers as configuration and distinguishes unsupported SSE from usable HTTP',async()=>{
  const root=await directory();await put(root,'plugin.json',JSON.stringify({$schema:pluginSchema,name:'portable'}));await put(root,'mcp.json',JSON.stringify({$schema:mcpSchema,mcpServers:{ordinary:{type:'streamable-http',url:'https://example.com/mcp',headers:{Accept:'application/json'}},legacy:{type:'sse',url:'https://example.com/sse'}}}));const pkg=await components.readPackage(root);expect(pkg.servers.find(server=>server.name==='ordinary')?.configurationReason).toContain('请求头');expect(pkg.servers.find(server=>server.name==='legacy')?.configurationReason).toContain('暂不支持');
 });
 it('retains an old WorkDay stdio server even when its url is an empty string',async()=>{
  const root=await directory();await put(root,'workday-plugin.json',JSON.stringify({id:'old-package',name:'Old',version:'1.0.0',appVersion:'0.1',skills:[],mcp:['mcp.json']}));await put(root,'mcp.json',JSON.stringify({name:'old-server',transport:'stdio',command:'/usr/bin/true',args:[],url:''}));expect((await components.readPackage(root)).servers[0]).toMatchObject({name:'old-server',transport:'stdio',command:'/usr/bin/true',url:''});
 });
 it('accepts more than twenty declared Skills and binary resources in old WorkDay packages',async()=>{
  const root=await directory();const refs=Array.from({length:21},(_,i)=>'skills/s'+i+'/SKILL.md');await put(root,'workday-plugin.json',JSON.stringify({id:'many-skills',name:'Many',version:'1.0.0',description:'',appVersion:'0.1',skills:refs,mcp:[]}));for(const file of refs)await put(root,file,entry);await put(root,'assets/data.bin',Buffer.alloc(3*1024*1024,42));expect((await components.readPackage(root)).skills).toHaveLength(21);
 });
 it('keeps app registration IDs as declarations and marks unsupported MCP configuration',async()=>{
  const root=await directory();await put(root,'.codex-plugin/plugin.json',JSON.stringify({name:'connections',version:'1.0.0',skills:'./skills',mcpServers:'./.mcp.json',apps:'./.app.json'}));await put(root,'skills/summary/SKILL.md',entry);await put(root,'.mcp.json',JSON.stringify({mcpServers:{remote:{url:'https://example.com/mcp',headers:{Authorization:'Bearer ${TOKEN}'}},local:{command:'node',args:['./mcp/server.mjs'],cwd:'.',env:{TOKEN:'${TOKEN}'}}}}));await put(root,'.app.json',JSON.stringify({apps:{host_only:{id:'registered-app-id'}}}));
  const pkg=await components.readPackage(root) as any;expect(pkg.declarations.apps).toEqual(['host_only']);expect(pkg.servers).toHaveLength(2);expect(pkg.servers.every((server:any)=>server.configurationReason)).toBe(true);expect(pkg.servers.find((server:any)=>server.name==='local').args[0]).toBe('${PLUGIN_ROOT}/mcp/server.mjs');expect(pkg.servers.some((server:any)=>server.url==='registered-app-id')).toBe(false);
 });
 it('rejects embedded credentials rather than copying them into a portable package',async()=>{
  const root=await directory();await put(root,'.codex-plugin/plugin.json',JSON.stringify({name:'secret-package',version:'1.0.0',mcpServers:'./.mcp.json'}));await put(root,'.mcp.json',JSON.stringify({mcpServers:{bad:{url:'https://example.com/mcp',headers:{Authorization:'Bearer example-private-token'}}}}));await expect(components.readPackage(root)).rejects.toThrow('凭证');
 });
 it('rejects symlinks, path traversal and noncanonical tree records before writing',async()=>{
  const root=await directory();await put(root,'SKILL.md',entry);const outside=await directory();await put(outside,'private.txt','PRIVATE');await fs.symlink(path.join(outside,'private.txt'),path.join(root,'linked'));await expect(components.readSkill(path.join(root,'SKILL.md'))).rejects.toThrow('符号链接');await fs.rm(path.join(root,'linked'));
  const file={encoding:'base64',data:Buffer.from('body').toString('base64'),mode:0o644,sha256:digest('body')};for(const key of ['../outside','/absolute','a/../b','a//b','a\\b','a\0b'])expect(()=>(components as any).validateTree({[key]:file})).toThrow();expect(()=>(components as any).validateTree({'a':{...file,sha256:'0'.repeat(64)}})).toThrow();expect(()=>(components as any).validateTree({'A':file,'a':file})).toThrow();expect(()=>(components as any).validateTree({'a':file,'a/b':file})).toThrow();
 });
 it('hashes path, bytes and mode deterministically and rejects writes into occupied directories',async()=>{
  const root=await directory();await put(root,'b.txt','B');await put(root,'a.txt','A');const tree=await (components as any).readTree(root);expect((components as any).treeHash(tree)).toBe((components as any).treeHash(Object.fromEntries(Object.entries(tree).reverse())));const changed=structuredClone(tree);changed['a.txt'].mode=0o755;expect((components as any).treeHash(changed)).not.toBe((components as any).treeHash(tree));const destination=await directory();await put(destination,'existing.txt','KEEP');await expect((components as any).writeTree(destination,tree)).rejects.toThrow();expect(await fs.readFile(path.join(destination,'existing.txt'),'utf8')).toBe('KEEP');
 });
 it('enforces file, total, depth and encoded tree limits without truncating data',async()=>{
  const root=await directory();const handle=await fs.open(path.join(root,'too-large.bin'),'w');await handle.truncate(32*1024*1024+1);await handle.close();await expect((components as any).readTree(root)).rejects.toThrow('32 MiB');
  const file={encoding:'base64',data:'',mode:0o644,sha256:digest('')};expect(()=>(components as any).validateTree({[Array(33).fill('d').join('/')]:file})).toThrow();expect(()=>(components as any).validateTree({'a':{...file,data:'!!!!'}})).toThrow();expect(()=>(components as any).validateTree({'a':{...file,mode:0o4755}})).toThrow();expect(()=>(components as any).validateTree(Object.fromEntries(Array.from({length:5001},(_,i)=>['f'+i,file])))).toThrow();
 });
});
