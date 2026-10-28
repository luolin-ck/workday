import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isAlias,isMap,isScalar,isSeq,parseDocument} from 'yaml';
import {z} from 'zod';
import {parse,requireThat,strictUtf8,remoteUrl,text,AppError} from './validation';

export type PackageFile={encoding:'base64';data:string;mode:number;sha256:string};
export type PackageTree=Record<string,PackageFile>;
export type PackageSkill={path:string;name:string;description:string;descriptionZh?:string;content:string};
export type PackageServer={path:string;name:string;transport:'stdio'|'http';command:string;args:string[];url:string;configurationReason?:string};
export type PackageData={manifest:{id:string;name:string;version:string;description:string;descriptionZh?:string;appVersion:'0.1';skills:string[];mcp:string[]};skills:PackageSkill[];servers:PackageServer[];tree:PackageTree;format:'workday'|'portable'|'legacy';declarations:{apps:string[];hooks:boolean}};
export const PACKAGE_LIMITS={bytes:64*1024*1024,fileBytes:32*1024*1024,files:5000,depth:32};
const PLUGIN_SCHEMA='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const portableManifestSchema=z.object({$schema:z.literal(PLUGIN_SCHEMA),name:z.string().max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),version:text(200).optional(),description:text(20000).optional(),author:z.object({name:text(1000).optional(),email:text(1000).optional(),url:text(2000).optional()}).strict().optional(),homepage:text(2000).optional(),repository:text(2000).optional(),license:text(1000).optional(),keywords:z.array(text(1000)).max(1000).optional(),extensions:z.record(z.record(z.unknown())).optional()}).strict();
const envSchema=z.record(text(2000)).refine(value=>!Object.hasOwn(value,'PLUGIN_ROOT')&&!Object.hasOwn(value,'PLUGIN_DATA'),'不能覆盖 Plugin 保留环境变量');
const portableMcpSchema=z.object({$schema:z.literal(MCP_SCHEMA),mcpServers:z.record(z.discriminatedUnion('type',[
 z.object({type:z.literal('stdio'),command:text(1000).min(1),args:z.array(text(2000)).max(50).optional(),env:envSchema.optional(),cwd:text(2000).refine(value=>value.startsWith('./')||value.startsWith('${PLUGIN_ROOT}/')||value.startsWith('${PLUGIN_DATA}/'),'MCP cwd 无效').optional()}).strict(),
 z.object({type:z.literal('streamable-http'),url:text(2000).min(1),headers:z.record(text(2000)).optional()}).strict(),
 z.object({type:z.literal('sse'),url:text(2000).min(1),headers:z.record(text(2000)).optional()}).strict()
]))}).strict();
const manifestSchema=z.object({id:z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),name:text(200).min(1),version:z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),description:text(20000).default(''),descriptionZh:text(20000).optional(),appVersion:z.literal('0.1'),skills:z.array(text(500)).max(PACKAGE_LIMITS.files),mcp:z.array(text(500)).max(100)}).strict();
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function chineseDescription(value:unknown){if(value===undefined)return undefined;requireThat(typeof value==='string'&&value.length<=20000&&!value.includes('\0'),'中文描述无效');return value.trim()||undefined;}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function relativePath(value:string){requireThat(typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0')&&!value.includes('\\')&&!path.posix.isAbsolute(value)&&!path.win32.isAbsolute(value),'包路径无效');const parts=value.split('/');requireThat(parts.length<=PACKAGE_LIMITS.depth&&parts.every(part=>part!==''&&part!=='.'&&part!=='..'),'包路径无效');return value;}
function manifestPath(value:string){requireThat(typeof value==='string','清单路径无效');return relativePath(value.replace(/^\.\//,'').replace(/\/$/,''));}
function decode(value:Buffer){let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{throw new AppError('INVALID','文件不是有效 UTF-8');}requireThat(!content.includes('\0')&&!/[\x01-\x08\x0e-\x1f]/.test(content),'文件包含二进制内容');return content;}

async function safeFile(root:string,relative:string,maxBytes:number){
 relativePath(relative);const realRoot=await fs.realpath(root);let full=realRoot;
 for(const segment of relative.split('/')){full=path.join(full,segment);const stat=await fs.lstat(full);requireThat(!stat.isSymbolicLink(),'包内不允许符号链接');}
 const real=await fs.realpath(full);requireThat(real.startsWith(realRoot+path.sep),'包路径越界');
 const handle=await fs.open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();requireThat(before.isFile()&&before.size<=maxBytes,'包内只允许大小受限的普通文件');const bytes=await handle.readFile();const after=await handle.stat();requireThat(bytes.length<=maxBytes&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&before.ino===after.ino,'源文件读取期间已变化');requireThat(await fs.realpath(full)===real,'源文件读取期间已变化');return {bytes,mode:before.mode&0o777};}finally{await handle.close();}
}
export async function boundedFile(root:string,relative:string){const value=await safeFile(root,relative,1024*1024).catch(error=>{if(error instanceof AppError&&error.message.includes('大小受限'))throw new AppError('INVALID','包内只允许最多 1 MB 的普通文本文件');throw error;});return strictUtf8(value.bytes);}

export function validateTree(tree:PackageTree):void{
 requireThat(plain(tree),'包文件清单无效');const entries=Object.entries(tree);requireThat(entries.length<=PACKAGE_LIMITS.files,'包文件数超过上限');const paths=new Set<string>();let bytes=0;
 for(const [ref,file] of entries){relativePath(ref);const normalized=ref.normalize('NFC').toLowerCase();requireThat(!paths.has(normalized),'包内存在重复规范路径');paths.add(normalized);requireThat(plain(file)&&Object.keys(file).sort().join(',')==='data,encoding,mode,sha256'&&file.encoding==='base64'&&typeof file.data==='string'&&file.data.length<=Math.ceil(PACKAGE_LIMITS.fileBytes/3)*4&&Number.isInteger(file.mode)&&file.mode>=0&&file.mode<=0o777&&typeof file.sha256==='string'&&/^[a-f0-9]{64}$/.test(file.sha256),'包文件记录无效');const data=Buffer.from(file.data,'base64');requireThat(data.toString('base64')===file.data&&data.length<=PACKAGE_LIMITS.fileBytes&&sha(data)===file.sha256,'包文件编码、大小或哈希无效');bytes+=data.length;requireThat(bytes<=PACKAGE_LIMITS.bytes,'包超过 64 MiB 大小上限');}
 for(const ref of paths){const parts=ref.split('/');for(let i=1;i<parts.length;i++)requireThat(!paths.has(parts.slice(0,i).join('/')),'包内文件与目录路径冲突');}
}
export function treeHash(tree:PackageTree){validateTree(tree);return sha(JSON.stringify(Object.keys(tree).sort().map(ref=>[ref,tree[ref].mode,tree[ref].sha256])));}
export async function readTree(root:string):Promise<PackageTree>{
 const rootStat=await fs.lstat(root);requireThat(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'包根必须是普通目录，不能是符号链接');const realRoot=await fs.realpath(root);const tree:PackageTree=Object.create(null);let bytes=0,entries=0;
 async function walk(directory:string,depth:number){requireThat(depth<=PACKAGE_LIMITS.depth,'包目录过深');for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){requireThat(++entries<=PACKAGE_LIMITS.files*2,'包目录项超过上限');const full=path.join(directory,entry.name);const stat=await fs.lstat(full);requireThat(!stat.isSymbolicLink(),'包内不允许符号链接');if(stat.isDirectory())await walk(full,depth+1);else {requireThat(stat.isFile(),'包内只允许普通文件和目录');const ref=relativePath(path.relative(realRoot,full).split(path.sep).join('/'));requireThat(Object.keys(tree).length<PACKAGE_LIMITS.files&&stat.size<=PACKAGE_LIMITS.fileBytes,'包文件数或单文件 32 MiB 大小超过上限');bytes+=stat.size;requireThat(bytes<=PACKAGE_LIMITS.bytes,'包超过 64 MiB 大小上限');const value=await safeFile(realRoot,ref,PACKAGE_LIMITS.fileBytes);tree[ref]={encoding:'base64',data:value.bytes.toString('base64'),mode:value.mode,sha256:sha(value.bytes)};}}
 }
 await walk(realRoot,0);validateTree(tree);return tree;
}
export async function writeTree(root:string,tree:PackageTree):Promise<void>{
 validateTree(tree);const parent=path.dirname(root);await fs.mkdir(parent,{recursive:true});const existing=await fs.lstat(root).catch(error=>{if(error.code==='ENOENT')return null;throw error;});requireThat(!existing||existing.isDirectory()&&!existing.isSymbolicLink()&&(await fs.readdir(root)).length===0,'安装目标必须不存在或是空目录');const stage=await fs.mkdtemp(path.join(parent,'.workday-package-'));
 try{for(const [ref,file] of Object.entries(tree)){const target=path.join(stage,ref);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const handle=await fs.open(target,'wx',file.mode);try{await handle.writeFile(Buffer.from(file.data,'base64'));await handle.chmod(file.mode);await handle.sync();}finally{await handle.close();}}requireThat(treeHash(await readTree(stage))===treeHash(tree),'安装文件校验失败');await fs.rename(stage,root);}catch(error){await fs.rm(stage,{recursive:true,force:true});throw error;}
}

export function skillContent(content:string){
 const match=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);requireThat(match,'SKILL.md 缺少 frontmatter');requireThat(match[1].length<=100000,'Skill frontmatter 过长');
 const document=parseDocument(match[1],{schema:'core',uniqueKeys:true});requireThat(!document.errors.length&&!document.warnings.length&&isMap(document.contents),'Skill frontmatter 必须是有效 YAML 映射');
 function check(node:unknown,depth=0){requireThat(depth<=32&&!isAlias(node),'Skill YAML 不允许别名或过深结构');if(isScalar(node)||isMap(node)||isSeq(node))requireThat(!node.tag&&!node.anchor,'Skill YAML 不允许标签或锚点');if(isMap(node))for(const item of node.items){requireThat(isScalar(item.key)&&typeof item.key.value==='string'&&!['__proto__','constructor','prototype'].includes(item.key.value),'Skill YAML 键无效');check(item.key,depth+1);check(item.value,depth+1);}else if(isSeq(node))for(const item of node.items)check(item,depth+1);}
 check(document.contents);const metadata=document.toJS({maxAliasCount:0}) as Record<string,unknown>;requireThat(typeof metadata.name==='string'&&metadata.name.trim().length>0&&metadata.name.length<=200&&typeof metadata.description==='string'&&metadata.description.trim().length>0&&metadata.description.length<=20000,'Skill 需要 name 和 description');const extra=metadata.metadata;if(extra!==undefined)requireThat(plain(extra),'Skill metadata 必须是映射');const descriptionZh=chineseDescription(plain(extra)?extra.description_zh:undefined);return {name:metadata.name.trim(),description:metadata.description,...(descriptionZh?{descriptionZh}:{}),content:match[2]};
}
function treeText(tree:PackageTree,ref:string){const file=tree[relativePath(ref)];requireThat(file,'包声明文件不存在：'+ref);return decode(Buffer.from(file.data,'base64'));}
function treeJson(tree:PackageTree,ref:string){let value:unknown;try{value=JSON.parse(treeText(tree,ref));}catch(error){if(error instanceof AppError)throw error;throw new AppError('INVALID','包 JSON 无效：'+ref);}requireThat(plain(value),'包 JSON 必须是对象：'+ref);return value;}
export async function readSkill(file:string){requireThat(path.basename(file)==='SKILL.md','Skill 入口必须是 SKILL.md');const tree=await readTree(path.dirname(file));const entry=path.basename(file);return {...skillContent(treeText(tree,entry)),tree,entry};}

/** Only add display metadata to entries that the selected package actually declares. */
export function addDescriptionsZh(tree:PackageTree,kind:'skill'|'plugin',entries:{path:string;descriptionZh:string}[]):PackageTree {
 validateTree(tree);requireThat(entries.length>0&&entries.length<=200,'中文描述数量无效');
 const data=kind==='plugin'?parsePackageTree(tree):null;
 const manifest=data?(data.format==='portable'?'plugin.json':data.format==='legacy'?'.codex-plugin/plugin.json':'workday-plugin.json'):null;
 const allowed=new Set(data?data.skills.map(s=>s.path):['SKILL.md']);if(manifest)allowed.add(manifest);
 const seen=new Set<string>();const result={...tree};let bytes=0;
 for(const entry of entries){const ref=relativePath(entry.path),key=ref.normalize('NFC').toLowerCase();requireThat(allowed.has(ref),'只能补充已声明组件入口的中文描述','PERMISSION');requireThat(!seen.has(key),'中文描述路径重复');seen.add(key);const descriptionZh=chineseDescription(entry.descriptionZh);requireThat(descriptionZh,'中文描述不能为空');bytes+=Buffer.byteLength(descriptionZh);requireThat(bytes<=128*1024,'中文描述合计超过 128 KiB');let content:string;
  if(ref===manifest){const json=treeJson(tree,ref),old=data!.manifest.descriptionZh;requireThat(!old||old===descriptionZh,'已有中文描述，不能覆盖','CONFLICT');if(old)continue;if(data!.format==='portable'){const extensions=plain(json.extensions)?json.extensions:{};json.extensions={...extensions,workday:{...(plain(extensions.workday)?extensions.workday:{}),descriptionZh}};}else json.descriptionZh=descriptionZh;content=JSON.stringify(json,null,2)+'\n';}
  else {const original=treeText(tree,ref),parsed=skillContent(original);requireThat(!parsed.descriptionZh||parsed.descriptionZh===descriptionZh,'已有中文描述，不能覆盖','CONFLICT');if(parsed.descriptionZh)continue;const parts=original.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/)!;const document=parseDocument(parts[2],{schema:'core',uniqueKeys:true});document.setIn(['metadata','description_zh'],descriptionZh);content=parts[1]+document.toString().trimEnd()+parts[3]+parts[4];skillContent(content);}
  const value=Buffer.from(content);result[ref]={...tree[ref],data:value.toString('base64'),sha256:sha(value)};
 }
 validateTree(result);if(data)parsePackageTree(result);return result;
}

function refs(value:unknown){if(value===undefined)return [];requireThat(typeof value==='string'||Array.isArray(value)&&value.every(item=>typeof item==='string'),'清单路径必须是字符串或数组');return (typeof value==='string'?[value]:value as string[]).map(manifestPath);}
function skillPaths(tree:PackageTree,declarations:unknown){const paths:string[]=[];for(const ref of refs(declarations)){const found=tree[ref]?[ref]:Object.keys(tree).filter(key=>key.startsWith(ref+'/')&&path.posix.basename(key)==='SKILL.md');requireThat(found.length>0,'Skill 声明路径不存在：'+ref);for(const item of found){requireThat(path.posix.basename(item)==='SKILL.md','Skill 入口必须是 SKILL.md');paths.push(item);}}requireThat(new Set(paths).size===paths.length,'Skill 重复声明');return paths.sort();}
function placeholder(value:unknown){return typeof value==='string'&&(value===''||/^(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value));}
function credentials(value:unknown){
 if(Array.isArray(value)){for(const item of value)credentials(item);return;}
 if(plain(value)){for(const [child,item] of Object.entries(value)){const normalized=child.toLowerCase().replace(/[-_]/g,'');if(['clientsecret','secret','password','token','apikey','accesstoken','refreshtoken','authorization'].includes(normalized))requireThat(placeholder(item),'包内不得包含凭证，请在 WorkDay 单独配置');credentials(item);}}
}
function serverValue(ref:string,name:string,input:unknown):PackageServer{
 requireThat(plain(input),'MCP 配置无效');credentials(input);requireThat(name.length>0&&name.length<=200,'MCP 名称无效');const reasons:string[]=[];const rawTransport=input.transport??input.type;const transport=rawTransport==='stdio'||rawTransport===undefined&&typeof input.command==='string'?'stdio':'http';if(rawTransport!==undefined&&!['stdio','http','streamable-http'].includes(String(rawTransport)))reasons.push('MCP transport 暂不支持，请配置 WorkDay 连接');
 const command=typeof input.command==='string'?input.command:'';const url=typeof input.url==='string'?input.url:'';requireThat(Array.isArray(input.args??[])&&((input.args??[]) as unknown[]).length<=50,'MCP 参数无效');const args=(input.args??[]) as unknown[];requireThat(args.every(arg=>typeof arg==='string'&&arg.length<=2000&&!arg.includes('\0')),'MCP 参数无效');
 if(transport==='http'){remoteUrl(url);if(input.headers!==undefined){requireThat(plain(input.headers)&&Object.values(input.headers).every(value=>typeof value==='string'),'MCP headers 无效');reasons.push('MCP 请求头需在 WorkDay 单独配置');}}
 else {requireThat(command.length>0&&command.length<=1000&&!command.includes('\0'),'MCP 程序无效');if(!path.isAbsolute(command)&&!command.startsWith('${PLUGIN_ROOT}/'))reasons.push('请配置 WorkDay MCP 程序的绝对路径');if(input.cwd!==undefined)reasons.push('MCP 工作目录需在 WorkDay 单独配置');}
 if(input.env!==undefined){requireThat(plain(input.env),'MCP env 无效');for(const [key,value] of Object.entries(input.env))if(/token|secret|password|key/i.test(key))requireThat(placeholder(value),'包内不得包含凭证，请在 WorkDay 单独配置');reasons.push('MCP 环境变量需在 WorkDay 单独配置');}
 if(input.auth!==undefined||input.oauth!==undefined||input.oauthConfig!==undefined)reasons.push('MCP 账号授权需在 WorkDay 单独配置');
 const normalizedArgs=(args as string[]).map(arg=>arg.startsWith('./')?'${PLUGIN_ROOT}/'+manifestPath(arg):arg);return {path:ref,name,transport,command,args:normalizedArgs,url,...(reasons.length?{configurationReason:reasons.join('；')}:{})};
}
function mcpValues(tree:PackageTree,declarations:unknown,portable=false){const servers:PackageServer[]=[];const paths=refs(declarations);for(const ref of paths){const data=treeJson(tree,ref);credentials(data);if(portable)parse(portableMcpSchema,data);if(plain(data.mcpServers)){for(const [name,value] of Object.entries(data.mcpServers))servers.push(serverValue(ref+'#'+name,name,value));}else {requireThat(typeof data.name==='string','MCP 缺少名称');servers.push(serverValue(ref,data.name,data));}}requireThat(servers.length<=100,'MCP 声明过多');return {servers,paths};}
function appNames(tree:PackageTree,declarations:unknown){let names:string[]=[];if(plain(declarations))names=Object.keys(declarations);else for(const ref of refs(declarations)){const data=treeJson(tree,ref);credentials(data);requireThat(plain(data.apps),'Apps 声明无效');names.push(...Object.keys(data.apps));}return [...new Set(names)].sort();}
export async function readPackage(root:string):Promise<PackageData>{return parsePackageTree(await readTree(root));}
export function parsePackageTree(tree:PackageTree):PackageData{
 validateTree(tree);const rootManifest=tree['plugin.json']?treeJson(tree,'plugin.json'):null;let format:PackageData['format'],metadata:Record<string,unknown>,overlay:Record<string,unknown>,skillRefs:string[],mcpRefs:string[];
 if(rootManifest?.$schema===PLUGIN_SCHEMA){format='portable';metadata=parse(portableManifestSchema,rootManifest);const extensions=plain(metadata.extensions)?metadata.extensions:null;const inline=extensions?.['com.openai'];if(inline!==undefined)requireThat(plain(inline),'OpenAI overlay 无效');overlay=plain(inline)?inline:tree['.codex-plugin/plugin.json']?treeJson(tree,'.codex-plugin/plugin.json'):{};skillRefs=skillPaths(tree,Object.keys(tree).some(ref=>ref.startsWith('skills/')&&path.posix.basename(ref)==='SKILL.md')?'skills':undefined);mcpRefs=tree['mcp.json']?['mcp.json']:[];
 }else if(tree['.codex-plugin/plugin.json']){format='legacy';metadata=treeJson(tree,'.codex-plugin/plugin.json');overlay=metadata;skillRefs=skillPaths(tree,metadata.skills);mcpRefs=refs(metadata.mcpServers);
 }else {requireThat(!rootManifest?.$schema,'Plugin schema 不支持');format='workday';const legacy=parse(manifestSchema,treeJson(tree,'workday-plugin.json'));metadata=legacy;overlay={};skillRefs=skillPaths(tree,legacy.skills);mcpRefs=legacy.mcp;}
 credentials(metadata);credentials(overlay);const face=plain(overlay.interface)?overlay.interface:plain(metadata.interface)?metadata.interface:{};const id=metadata.id??metadata.name;requireThat(typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id),'Plugin 身份无效');const name=face.displayName??metadata.displayName??metadata.name;requireThat(typeof name==='string'&&name.length>0&&name.length<=200,'Plugin 名称无效');const version=metadata.version??'0.0.0';requireThat(typeof version==='string'&&version.length<=200&&(format==='portable'||/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)),'Plugin 版本无效');const description=metadata.description??face.shortDescription??'';requireThat(typeof description==='string'&&description.length<=20000,'Plugin 说明无效');const extensions=plain(metadata.extensions)?metadata.extensions:{};const workday=extensions.workday;if(workday!==undefined)requireThat(plain(workday),'WorkDay 扩展无效');const descriptionZh=chineseDescription(format==='portable'&&plain(workday)?workday.descriptionZh:metadata.descriptionZh);const skills=skillRefs.map(ref=>({path:ref,...skillContent(treeText(tree,ref))}));const mcp=mcpValues(tree,mcpRefs,format==='portable');return {manifest:{id,name,version,description,...(descriptionZh?{descriptionZh}:{}),appVersion:'0.1',skills:skillRefs,mcp:mcp.paths},skills,servers:mcp.servers,tree,format,declarations:{apps:appNames(tree,overlay.apps),hooks:overlay.hooks!==undefined}};
}
