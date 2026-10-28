import {execFile} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {KeychainResult} from '../shared/types';

const LIMIT=4096;
const native=z.object({status:z.enum(['notFound','notListed','listed','locked','unsupportedPackage','needsManual','cancelled','error','unverified','updated','unknown']),signing:z.enum(['adhoc','signed','unknown'])}).strict();
type Runner=(file:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<string>;
const run:Runner=(file,args,options)=>new Promise((resolve,reject)=>execFile(file,args,{...options,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)));
const messages:Record<KeychainResult['status'],string>={unsupported:'钥匙串访问设置仅支持 macOS。',unsupportedPackage:'请打开正式安装的 WorkDay 应用后配置。',notFound:'尚未找到 WorkDay 的安全存储条目。首次保存凭证后可重新检查。',notListed:'访问列表尚未包含当前 WorkDay，可点击自动配置。',listed:'访问列表中已有 WorkDay，当前版本是否仍获授权需系统确认。如仍弹窗，可重新配置。',locked:'钥匙串已锁定或不允许读取，请在钥匙串中解锁后重新检查。',needsManual:'当前钥匙串设置需要手动处理，请打开钥匙串检查 WorkDay Safe Storage。',cancelled:'已取消配置，可随时重试。',error:'无法完成操作，请重新检查或打开钥匙串。',unverified:'操作结果尚未确认，设置可能已改变。请重新检查后按需配置。',updated:'已更新钥匙串访问设置。',unknown:'暂时无法确认钥匙串访问设置，请重新检查。',busy:'正在配置钥匙串，请等待系统窗口处理完成。'};
export class KeychainAccess {
 private configuring=false;
 constructor(private runner:Runner=run,private platform:string=process.platform,_packagedHint=false,private executable=process.execPath,private mainFile=__filename){}
 private result(status:KeychainResult['status'],signing:KeychainResult['signing']='unknown'):KeychainResult{return {status,signing,canConfigure:['listed','notListed','updated','cancelled','error','unverified','unknown'].includes(status),message:messages[status]};}
 private async official(){
  // Electron reports false for our manual bundle; canonical paths and native identity remain the boundary.
  const app=path.resolve(this.executable,'../../..');
  return path.basename(app)==='WorkDay.app'&&this.executable===path.join(app,'Contents/MacOS/Electron')&&this.mainFile===path.join(app,'Contents/Resources/app/dist/main/keychain-access.js')&&await realpath(this.executable)===this.executable&&await realpath(app)===app&&await realpath(this.mainFile)===this.mainFile;
 }
 private async operate(command:'status'|'configure'):Promise<KeychainResult>{
  if(this.platform!=='darwin')return this.result('unsupported');
  try{if(!await this.official())return this.result('unsupportedPackage');}catch{return this.result('unsupportedPackage');}
  if(this.configuring)return this.result('busy');
  if(command==='configure')this.configuring=true;
  try{
   const raw=await this.runner(path.resolve(__dirname,'../../native/keychain-access'),[command],{timeout:command==='configure'?120000:15000,maxBuffer:LIMIT});
   if(Buffer.byteLength(raw)>LIMIT)throw new Error('size');
   const response=native.parse(JSON.parse(raw));
   if(command==='status'&&['updated','cancelled'].includes(response.status))throw new Error('unexpected status');
   return this.result(response.status,response.signing);
  }catch(error){return this.result(command==='configure'?'unverified':'unknown');}
  finally{if(command==='configure')this.configuring=false;}
 }
 status(){return this.operate('status');}
 configure(){return this.operate('configure');}
 async open():Promise<boolean>{
  if(this.platform!=='darwin')return false;
  try{await this.runner('/usr/bin/open',['-b','com.apple.keychainaccess'],{timeout:10000,maxBuffer:1024});return true;}catch{return false;}
 }
}
