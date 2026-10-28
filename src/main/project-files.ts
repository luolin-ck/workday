import {spawn} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {type LocalRoot,projectRelativePath,projectSafeText} from './project-reader';
import {AppError,requireThat} from './validation';
const identity=z.object({dev:z.number().int().nonnegative().safe(),ino:z.number().int().nonnegative().safe()}).strict();
const rootSchema=identity.extend({root:z.string().min(1).max(4096)}).strict();
const parent=identity.extend({path:z.string().max(512)}).strict();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema=z.object({root:rootSchema,path:z.string(),text:z.string().max(12000),hash:digest,identity,parents:z.array(parent).min(1).max(10)}).strict();
const preparedSchema=z.object({root:rootSchema,path:z.string(),before:z.string().max(12000).nullable().default(null),after:z.string().max(12000),beforeHash:digest.nullable().default(null),afterHash:digest,fileIdentity:identity.optional(),parents:z.array(parent).min(1).max(10)}).strict();
export type FileEvidence=z.infer<typeof evidenceSchema>;
export type PreparedProjectFile=z.infer<typeof preparedSchema>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function content(value:string){requireThat(typeof value==='string'&&value.length<=12000&&Buffer.byteLength(value)<=16384,'文件内容最多 12,000 字符及 16 KiB','LIMIT');requireThat(Buffer.from(value).toString('utf8')===value,'文件内容不是有效 UTF-8 文本','FILE');projectSafeText(Buffer.from(value));return value;}
function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new AppError('CANCELLED','项目文件操作已取消');}
async function native<S extends z.ZodTypeAny>(request:object,schema:S,signal?:AbortSignal):Promise<z.output<S>>{
 cancelled(signal);requireThat(process.platform==='darwin','项目文件操作仅支持 macOS','UNAVAILABLE');
 return new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(__dirname,'../../native/project-files'),[],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
  let bytes=0,output='',failed=false,aborted=false;
  const finish=(error:Error)=>{if(!failed){failed=true;reject(error);}};
  const abort=()=>{aborted=true;child.kill('SIGTERM');};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{aborted=true;child.kill('SIGTERM');},20000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>131072){child.kill('SIGTERM');finish(new AppError('LIMIT','原生文件操作响应过大'));}else output+=chunk;});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.once('error',()=>finish(new AppError('UNAVAILABLE','项目文件原生程序不可用，请重新构建应用')));
  child.once('close',()=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failed)return;
   if(aborted||signal?.aborted){finish(new AppError(signal?.aborted?'CANCELLED':'UNAVAILABLE',signal?.aborted?'项目文件操作已取消':'项目文件操作超时'));return;}
   try{const result=JSON.parse(output);if(result?.ok===false){const error=z.object({ok:z.literal(false),code:z.enum(['INVALID','SECURITY','CONFLICT','LIMIT','FILE']),message:z.string().max(200)}).strict().parse(result);finish(new AppError(error.code,error.message));return;}const response=z.object({ok:z.literal(true),value:schema}).strict().parse(result);resolve(response.value);}catch{finish(new AppError('UNAVAILABLE','项目文件原生程序返回无效结果'));}
  });
  child.stdin.end(JSON.stringify(request));
 });
}
export async function readProjectFile(root:LocalRoot,value:string,signal?:AbortSignal):Promise<FileEvidence>{projectRelativePath(value);const result=await native({operation:'read',root,path:value},evidenceSchema,signal);requireThat(result.path===value&&result.root.root===root.root&&result.root.dev===root.dev&&result.root.ino===root.ino&&hash(content(result.text))===result.hash,'原生文件读取证据不一致','SECURITY');return result;}
export async function prepareProjectFile(root:LocalRoot,value:string,next:string,expected:FileEvidence|null,signal?:AbortSignal):Promise<PreparedProjectFile>{
 projectRelativePath(value);content(next);
 if(expected){evidenceSchema.parse(expected);requireThat(expected.path===value&&expected.root.root===root.root&&expected.root.dev===root.dev&&expected.root.ino===root.ino&&hash(content(expected.text))===expected.hash,'文件读取证据无效','SECURITY');}
 const result=await native({operation:'prepare',root,path:value,content:next,expected},preparedSchema,signal);
 requireThat(result.path===value&&result.root.root===root.root&&result.root.dev===root.dev&&result.root.ino===root.ino&&result.after===next&&result.afterHash===hash(next)&&result.before===(expected?.text??null)&&result.beforeHash===(expected?.hash??null),'原生文件变更证据不一致','SECURITY');return result;
}
export async function applyProjectFile(prepared:PreparedProjectFile,options:{recover?:boolean;signal?:AbortSignal}={}):Promise<{alreadyApplied:boolean}>{const value=preparedSchema.parse(prepared);projectRelativePath(value.path);content(value.after);if(value.before!==null)content(value.before);requireThat(hash(value.after)===value.afterHash&&(value.before===null?value.beforeHash===null:hash(value.before)===value.beforeHash),'文件变更内容校验失败','SECURITY');return native({operation:'apply',prepared:value,recover:options.recover===true},z.object({alreadyApplied:z.boolean()}).strict(),options.signal);}
