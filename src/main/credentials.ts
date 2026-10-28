import fs from 'node:fs/promises';
import {atomicWrite} from './store';
import {AppError,requireThat} from './validation';
export interface CryptoStorage {isEncryptionAvailable():boolean;encryptString(text:string):Buffer;decryptString(bytes:Buffer):string}
export class Credentials {
 private values:Record<string,string>={};
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private file:string,private crypto:CryptoStorage){}
 async init(){try{this.values=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 configured(id:string){return !!this.values[id];}
 get(id:string){if(!this.values[id])return '';requireThat(this.crypto.isEncryptionAvailable(),'系统安全存储不可用','CREDENTIAL');return this.crypto.decryptString(Buffer.from(this.values[id],'base64'));}
 async set(id:string,secret:string){const run=this.queue.then(async()=>{requireThat(secret.length<=4096,'密钥过长');const next={...this.values};if(secret){requireThat(this.crypto.isEncryptionAvailable(),'系统安全存储不可用，无法保存密钥','CREDENTIAL');next[id]=this.crypto.encryptString(secret).toString('base64');}else delete next[id];await atomicWrite(this.file,JSON.stringify(next));this.values=next;});this.queue=run.catch(()=>undefined);await run;}
 // Keep ciphertext opaque: deleting a source must not require decrypting its key.
 async removeWithRollback<T>(id:string,commit:()=>Promise<T>):Promise<T>{
  const run=this.queue.then(async()=>{
   const previous={...this.values},next={...previous};delete next[id];
   await atomicWrite(this.file,JSON.stringify(next));
   try{const result=await commit();this.values=next;return result;}
   catch(error){try{await atomicWrite(this.file,JSON.stringify(previous));}catch{throw new AppError('CREDENTIAL','删除未完成，凭证恢复失败；请检查磁盘后重新配置 API Key');}throw error;}
  });this.queue=run.catch(()=>undefined);return run;
 }
 async remove(id:string){await this.set(id,'');}
}
