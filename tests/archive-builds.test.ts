import {afterEach,describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const {archiveBuild,latestRollback,removeBuild}=createRequire(import.meta.url)('../scripts/archive-builds.cjs');
const roots:string[]=[];
async function fixture(name='WorkDay-fixture-stage.app',id='local.workday.desktop'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workday-archive-test-'));roots.push(root);
 const app=path.join(root,'release',name);await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
 await fs.writeFile(path.join(app,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
 await fs.writeFile(path.join(app,'Contents/MacOS/fixture'),'synthetic executable');await fs.chmod(path.join(app,'Contents/MacOS/fixture'),0o755);
 await fs.symlink('MacOS/fixture',path.join(app,'Contents/current'));
 return {root,app,name};
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
describe('reversible build archives',()=>{
 it('keeps only the newest timestamped rollback rather than a stage build',()=>{
  expect(latestRollback(['previous-tabs-20261020-130148.app','WorkDay-new-stage.app','previous-headings-20261020-195802.app','previous-theme-20261015-172351.app'])).toBe('previous-headings-20261020-195802.app');
  expect(latestRollback(['WorkDay-new-stage.app'])).toBeUndefined();
 });
 it('removes a disposable build while refusing a live, foreign or running app',async()=>{
  const old=await fixture();await removeBuild(old.root,old.name,'');await expect(fs.access(old.app)).rejects.toThrow();
  const live=await fixture('WorkDay.app');await expect(removeBuild(live.root,live.name,'')).rejects.toThrow();await fs.access(live.app);
  const foreign=await fixture('previous-foreign.app','unrelated.app');await expect(removeBuild(foreign.root,foreign.name,'')).rejects.toThrow();await fs.access(foreign.app);
  const running=await fixture();await expect(removeBuild(running.root,running.name,running.app+'/Contents/MacOS/fixture')).rejects.toThrow('运行');await fs.access(running.app);
 });
 it('restores bytes, executable mode and symlinks after removing the duplicate app',async()=>{
  const f=await fixture(),result=await archiveBuild(f.root,f.name,'');
  expect(result?.archive).toMatch(/\.zip$/);await expect(fs.access(f.app)).rejects.toThrow();
  const restored=path.join(f.root,'restored');execFileSync('/usr/bin/ditto',['-x','-k',result.archive,restored]);
  const contents=path.join(restored,f.name,'Contents');
  expect(await fs.readFile(path.join(contents,'MacOS/fixture'),'utf8')).toBe('synthetic executable');
  expect((await fs.stat(path.join(contents,'MacOS/fixture'))).mode&0o777).toBe(0o755);
  expect(await fs.readlink(path.join(contents,'current'))).toBe('MacOS/fixture');
 });
 it.each(['WorkDay.app','Other.app'])('refuses the live app or unrelated name %s',async name=>{
  const f=await fixture(name);await expect(archiveBuild(f.root,name,'')).rejects.toThrow();await fs.access(f.app);
 });
 it('refuses an unrelated identity, symlink bundle or running build',async()=>{
  const f=await fixture('previous-fixture.app','unrelated.app');await expect(archiveBuild(f.root,f.name,'')).rejects.toThrow();await fs.access(f.app);
  const good=await fixture();await expect(archiveBuild(good.root,good.name,good.app+'/Contents/MacOS/fixture')).rejects.toThrow('运行');await fs.access(good.app);
  const linked='WorkDay-linked-stage.app';await fs.symlink(good.app,path.join(good.root,'release',linked));
  await expect(archiveBuild(good.root,linked,'')).rejects.toThrow();await fs.access(good.app);
 });
});
