import {describe,it,expect,vi,afterAll} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {KeychainAccess} from '../src/main/keychain-access';
import {schemas} from '../src/main/schemas';
import {OPERATIONS} from '../src/shared/api';
const directories:string[]=[];
async function packaged(runner:any,packagedHint=true,bundleName='WorkDay.app'){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-keychain-unit-')));directories.push(directory);
 const app=path.join(directory,bundleName),executable=path.join(app,'Contents/MacOS/Electron'),main=path.join(app,'Contents/Resources/app/dist/main/keychain-access.js');
 for(const file of [executable,main]){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'fixture');}
 return new KeychainAccess(runner,'darwin',packagedHint,executable,main);
}
afterAll(async()=>{for(const dir of directories)await fs.rm(dir,{recursive:true,force:true});});
describe('keychain settings boundary',()=>{
 it('registers strict empty-input operations',()=>{
  for(const op of ['security.keychain.status','security.keychain.configure','security.keychain.open']){
   expect(OPERATIONS).toContain(op);
   expect(schemas[op]?.safeParse({}).success).toBe(true);
   for(const extra of [{app:'/Other.app'},{service:'other'},{account:'other'},{command:'configure'},{keychain:'/tmp/other'}])expect(schemas[op]?.safeParse(extra).success).toBe(false);
  }
 });
 it('does not invoke a helper outside macOS, dev, or stage and never probes safeStorage',async()=>{
  const runner=vi.fn();
  for(const client of [new KeychainAccess(runner,'linux'),new KeychainAccess(runner,'darwin'),new KeychainAccess(runner,'darwin',true,'/tmp/WorkDay-keychain-stage.app/Contents/MacOS/Electron')]){
   expect(['unsupported','unsupportedPackage']).toContain((await client.status()).status);
   expect((await client.configure()).canConfigure).toBe(false);
  }
  expect(runner).not.toHaveBeenCalled();
 });
 it('accepts the canonical manual WorkDay bundle when Electron reports isPackaged false',async()=>{
  const runner=vi.fn(async(_file:string,args:string[])=>JSON.stringify({status:args[0]==='status'?'listed':'updated',signing:'adhoc'}));
  const client=await packaged(runner,false);
  expect(await client.status()).toMatchObject({status:'listed',canConfigure:true});
  expect(await client.configure()).toMatchObject({status:'updated',canConfigure:true});
  expect(runner.mock.calls.map(([,args])=>args)).toEqual([['status'],['configure']]);
 });
 it.each(['Electron.app','WorkDay-keychain-stage.app','WorkDay-unified-final-stage.app','WorkDay-previous-keychain.app'])('rejects nonformal %s bundles even with a false packaged hint',async bundleName=>{
  const runner=vi.fn(),client=await packaged(runner,false,bundleName);
  expect((await client.status()).status).toBe('unsupportedPackage');
  expect((await client.configure()).status).toBe('unsupportedPackage');
  expect(runner).not.toHaveBeenCalled();
 });
 it.each(['executable','mainFile'])('rejects a symlinked %s in a manual bundle',async field=>{
  const runner=vi.fn(),client=await packaged(runner,false),file=(client as any)[field];
  await fs.rename(file,file+'.real');await fs.symlink(file+'.real',file);
  expect((await client.status()).status).toBe('unsupportedPackage');
  expect((await client.configure()).status).toBe('unsupportedPackage');expect(runner).not.toHaveBeenCalled();
 });
 it('rejects a foreign main module in a manual bundle',async()=>{
  const runner=vi.fn(),client=await packaged(runner,false);(client as any).mainFile=path.join(path.dirname((client as any).mainFile),'index.js');
  expect((await client.configure()).status).toBe('unsupportedPackage');expect(runner).not.toHaveBeenCalled();
 });
 it('uses only fixed helper arguments and exposes conservative listed facts',async()=>{
  const runner=vi.fn(async()=>JSON.stringify({status:'listed',signing:'adhoc'})),client=await packaged(runner);
  expect(await client.status()).toMatchObject({status:'listed',canConfigure:true,signing:'adhoc'});
  const [file,args,options]=runner.mock.calls[0] as any;
  expect(file.endsWith('/native/keychain-access')).toBe(true);expect(args).toEqual(['status']);expect(options).toEqual({timeout:15000,maxBuffer:4096});
  await client.configure();expect((runner.mock.calls[1] as any)[1]).toEqual(['configure']);expect((runner.mock.calls[1] as any)[2].timeout).toBe(120000);
 });
 it.each(['notFound','locked','needsManual','cancelled','error','unverified','updated','unknown','notListed'])('preserves safe %s outcomes without permanent authorization claims',async status=>{
  const client=await packaged(async()=>JSON.stringify({status,signing:'adhoc'}));
  const value=await client.configure();expect(value.status).toBe(status);expect(value.message).not.toContain('永久');
  expect(value.canConfigure).toBe(!['notFound','locked','needsManual'].includes(status));
 });
 it.each(['PRIVATE_STDERR','x'.repeat(4097),JSON.stringify({status:'updated',signing:'adhoc',secret:'DO_NOT_LEAK'}),JSON.stringify({status:'listed',signing:'other'})])('rejects malformed or oversized output without leaking content',async raw=>{
  const client=await packaged(async()=>raw);
  expect(await client.status()).toMatchObject({status:'unknown'});
  expect(await client.configure()).toMatchObject({status:'unverified'});
 });
 it('never treats native status updated or a timeout as success and permits retry',async()=>{
  const runner=vi.fn().mockResolvedValueOnce(JSON.stringify({status:'updated',signing:'adhoc'})).mockRejectedValueOnce(new Error('PRIVATE_TIMEOUT')).mockResolvedValueOnce(JSON.stringify({status:'updated',signing:'signed'}));
  const client=await packaged(runner);expect((await client.status()).status).toBe('unknown');
  expect((await client.configure()).status).toBe('unverified');expect((await client.configure()).status).toBe('updated');
 });
 it('prevents simultaneous mutations and status during native confirmation',async()=>{
  let finish!:(value:string)=>void;const runner=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;})),client=await packaged(runner);
  const first=client.configure();await vi.waitFor(()=>expect(runner).toHaveBeenCalledTimes(1));
  expect((await client.configure()).status).toBe('busy');expect((await client.status()).status).toBe('busy');
  finish(JSON.stringify({status:'cancelled',signing:'adhoc'}));expect((await first).status).toBe('cancelled');
 });
 it('opens only the fixed Keychain Access app and keeps it separate from configure',async()=>{
  const runner=vi.fn(async()=>''),client=new KeychainAccess(runner,'darwin');
  expect(await client.open()).toBe(true);expect(runner).toHaveBeenCalledWith('/usr/bin/open',['-b','com.apple.keychainaccess'],{timeout:10000,maxBuffer:1024});
  expect(await new KeychainAccess(vi.fn(),'linux').open()).toBe(false);
 });
 it('rejects symlinked application roots',async()=>{
  const runner=vi.fn(),client=await packaged(runner,false),context=client as any;
  const root=path.resolve(context.executable,'../../..'),alias=path.join(path.dirname(root),'alias');await fs.symlink(path.dirname(root),alias);
  context.executable=path.join(alias,'WorkDay.app/Contents/MacOS/Electron');context.mainFile=path.join(alias,'WorkDay.app/Contents/Resources/app/dist/main/keychain-access.js');
  expect((await client.configure()).status).toBe('unsupportedPackage');expect(runner).not.toHaveBeenCalled();
 });
});
