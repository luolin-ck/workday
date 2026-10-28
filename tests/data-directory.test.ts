import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/main/store';
import {Credentials} from '../src/main/credentials';
import {AppService} from '../src/main/service';
import {AppError} from '../src/main/validation';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
async function fixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workday-open-directory-'));
 const store=await Store.open(path.join(dir,'workday.sqlite'));
 const credentials=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()});
 await credentials.init();
 const openDirectory=vi.fn(async(_directory:string)=>{});
 const service=new AppService(store,credentials,{openProject:async()=>null,openText:async()=>null,openSkill:async()=>null,openPlugin:async()=>null,saveBackup:async()=>null,openBackup:async()=>null,openExternal:async()=>{},openDirectory},dir);
 cleanup.push(async()=>{await service.dispose();store.close();await fs.rm(dir,{recursive:true,force:true});});
 return {service,dir,openDirectory};
}

it('opens the displayed data directory without changing business data or emitting state changes',async()=>{
 const {service,dir,openDirectory}=await fixture();
 const before=await service.call('state.get',{}),events:unknown[]=[];
 const unsubscribe=service.subscribe(event=>events.push(event));
 try{
  expect(before.dataDirectory).toBe(dir);
  await expect(service.call('data.openDirectory',{})).resolves.toBe(true);
  expect(openDirectory).toHaveBeenCalledExactlyOnceWith(before.dataDirectory);
  expect(await service.call('state.get',{})).toEqual(before);
  expect(events).toEqual([]);
 }finally{unsubscribe();}
});

it('rejects a supplied path before invoking the native folder opener',async()=>{
 const {service,openDirectory}=await fixture();
 await expect(service.call('data.openDirectory',{path:'/unrelated-folder'})).rejects.toThrow('参数');
 expect(openDirectory).not.toHaveBeenCalled();
});

it('propagates a native failure and allows retry',async()=>{
 const {service,dir,openDirectory}=await fixture();
 openDirectory.mockRejectedValueOnce(new AppError('OPEN_DIRECTORY','无法打开数据文件夹，请检查目录是否存在或访问权限'));
 await expect(service.call('data.openDirectory',{})).rejects.toMatchObject({code:'OPEN_DIRECTORY',message:expect.stringContaining('无法打开数据文件夹')});
 await expect(service.call('data.openDirectory',{})).resolves.toBe(true);
 expect(openDirectory).toHaveBeenCalledTimes(2);
 expect(openDirectory).toHaveBeenLastCalledWith(dir);
});
