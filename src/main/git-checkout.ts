import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {RepositoryRef} from '../shared/types';
import {AppError,parse,repositoryRef,requireThat} from './validation';
import {captureLocalRoot,type LocalRoot} from './project-reader';
export type GitRun=(args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal})=>Promise<void>;
const run:GitRun=(args,options)=>new Promise((resolve,reject)=>{const child=spawn('/usr/bin/git',args,{...options,stdio:['ignore','ignore','pipe'],shell:false});let failure:Error|undefined;child.stderr.resume();child.once('error',error=>{failure=error;});child.once('close',code=>{if(failure)reject(failure);else if(code===0)resolve();else reject(new AppError('GIT','仓库下载失败，请检查账号仓库权限及网络'));});});
function cleanEnvironment(url:string,secret:string,template:string):NodeJS.ProcessEnv {
 const settings=[['http.'+url+'.extraHeader','Authorization: Basic '+Buffer.from('x-access-token:'+secret).toString('base64')],['credential.helper',''],['core.hooksPath',template],['init.templateDir',template],['http.followRedirects','false'],['protocol.allow','never'],['protocol.https.allow','always'],['core.autocrlf','false'],['core.attributesFile','/dev/null']];
 const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/usr/bin/false',SSH_ASKPASS:'/usr/bin/false',GIT_PROTOCOL_FROM_USER:'0',GIT_LFS_SKIP_SMUDGE:'1',GIT_CONFIG_COUNT:String(settings.length)};
 settings.forEach(([key,value],i)=>{env['GIT_CONFIG_KEY_'+i]=key;env['GIT_CONFIG_VALUE_'+i]=value;});return env;
}
export class GitCheckout {
 private controllers=new Set<AbortController>();
 private active=new Set<Promise<string>>();
 constructor(private execute:GitRun=run,private timeout=120000){}
 clone(ref:RepositoryRef,secret:string,desktop:string,guard:()=>void):Promise<string>{const pending=this.cloneInternal(ref,secret,desktop,guard);this.active.add(pending);void pending.finally(()=>this.active.delete(pending)).catch(()=>undefined);return pending;}
 private async cloneInternal(ref:RepositoryRef,secret:string,desktop:string,guard:()=>void):Promise<string>{
  parse(repositoryRef,ref);requireThat(secret&&!/[\s\0-\x1f\x7f]/.test(secret),'仓库凭证不可用','CREDENTIAL');guard();
  const root=await captureLocalRoot(desktop,new AbortController().signal),target=path.join(root.root,ref.owner+'-'+ref.name),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(this.timeout,120000));this.controllers.add(controller);
  let owned:LocalRoot|undefined,finished=false,template:string|undefined,templateOwner:LocalRoot|undefined;
  try{await fs.mkdir(target);const st=await fs.lstat(target);owned={root:target,dev:st.dev,ino:st.ino};template=await fs.mkdtemp(path.join(root.root,'.workday-git-'));const templateStat=await fs.lstat(template);templateOwner={root:template,dev:templateStat.dev,ino:templateStat.ino};await this.verify(root,owned);const url=`https://github.com/${ref.owner}/${ref.name}.git`,env=cleanEnvironment(url,secret,template);guard();
   await this.execute(['clone','--no-checkout','--no-recurse-submodules','--template='+template,'--',url,target],{cwd:root.root,env,signal:controller.signal});guard();await this.verify(root,owned);
   await this.execute(['-C',target,'-c','core.hooksPath='+template,'checkout','--force'],{cwd:root.root,env,signal:controller.signal});guard();await this.verify(root,owned);requireThat(!controller.signal.aborted,'仓库下载已停止或超时','CANCELLED');finished=true;return target;
  }catch(error){if(owned&&!finished){try{await this.verify(root,owned);await fs.rm(target,{recursive:true,force:true});}catch{/* Preserve a replaced directory; never remove uncertain ownership. */}}
   if((error as NodeJS.ErrnoException).code==='EEXIST')throw new AppError('CONFLICT','桌面已有 '+ref.owner+'-'+ref.name+'，请选择该本地文件夹或先改名');if(controller.signal.aborted)throw new AppError('CANCELLED','仓库下载已停止或超时，本次目录已清理或保留供检查');if((error as NodeJS.ErrnoException).code==='ENOENT')throw new AppError('GIT','未找到 Git，请先安装 macOS 命令行工具');if(error instanceof AppError)throw error;throw new AppError('GIT','仓库下载失败，请检查 Git、账号仓库权限及网络');
  }finally{clearTimeout(timer);this.controllers.delete(controller);if(template&&templateOwner)try{await this.verify(root,templateOwner);await fs.rm(template,{recursive:true,force:true});}catch{/* An uncertain temporary path is preserved for inspection. */}}
 }
 private async verify(root:LocalRoot,owned:LocalRoot){for(const item of [root,owned]){const st=await fs.lstat(item.root);requireThat(st.isDirectory()&&!st.isSymbolicLink()&&st.dev===item.dev&&st.ino===item.ino,'下载目录身份已变化，保留现有内容供检查','CONFLICT');}}
 async dispose(){for(const c of this.controllers)c.abort();await Promise.allSettled([...this.active]);}
}
