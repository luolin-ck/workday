const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const bundleId='local.workday.desktop';
const buildName=/^(?:WorkDay(?:-[a-z0-9]+)*-stage|previous-[a-z0-9-]+)\.app$/;
const lsregister='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function identity(app){return execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();}
function notRunning(app,processes){
 const current=processes??execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'});
 // Process paths may use aliases such as /var instead of /private/var.
 if(current.split('\n').some(line=>line.includes(path.basename(app)+'/Contents/')))throw new Error('构建包正在运行，先正常退出：'+app);
}
async function validate(root,name,processes){
 if(!buildName.test(name)||path.basename(name)!==name)throw new Error('只归档测试/回滚包，不能处理正式应用或其它文件');
 const release=path.join(root,'release'),app=path.join(release,name);
 for(const p of [release,app,path.join(app,'Contents')]){const s=await fs.lstat(p);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('拒绝符号链接或非目录：'+p);}
 if((await fs.lstat(path.join(app,'Contents/Info.plist'))).isSymbolicLink()||identity(app)!==bundleId)throw new Error('应用标识不匹配');
 notRunning(app,processes);return app;
}
async function tree(base){
 const entries=Object.create(null);
 async function visit(relative){
  const p=path.join(base,relative),s=await fs.lstat(p);
  if(s.isSymbolicLink())entries[relative]=['link',await fs.readlink(p)];
  else if(s.isDirectory()){entries[relative]=['directory',s.mode&0o777];for(const name of (await fs.readdir(p)).sort())await visit(path.join(relative,name));}
  else if(s.isFile())entries[relative]=['file',s.mode&0o777,digest(await fs.readFile(p))];
  else throw new Error('不支持的文件类型：'+p);
 }
 await visit('');return JSON.stringify(entries);
}
async function archiveBuild(root,name,processes){
 root=await fs.realpath(root);const app=await validate(root,name,processes),before=await tree(app),hash=digest(before);
 const directory=path.join(root,'release/build-archives');await fs.mkdir(directory,{recursive:true});
 if((await fs.lstat(directory)).isSymbolicLink())throw new Error('归档目录不能为符号链接');
 const archive=path.join(directory,name+'-'+hash.slice(0,12)+'-'+crypto.randomUUID()+'.zip'),partial=archive+'.partial';
 try{execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,partial]);await fs.rename(partial,archive);}
 finally{await fs.rm(partial,{force:true});}
 const checks=path.join(directory,'.verify.noindex');await fs.mkdir(checks,{recursive:true});
 if((await fs.lstat(checks)).isSymbolicLink())throw new Error('验证目录不能为符号链接');
 const restored=await fs.mkdtemp(path.join(checks,'restore-'));
 try{
  execFileSync('/usr/bin/ditto',['-x','-k',archive,restored]);
  if(await tree(path.join(restored,name))!==before)throw new Error('归档恢复校验不匹配，原构建保留');
  await validate(root,name,processes);
  if(await tree(app)!==before)throw new Error('归档期间源文件改变，原构建保留');
  await fs.rm(app,{recursive:true});
 }finally{await fs.rm(restored,{recursive:true,force:true});}
 return {source:app,archive,manifestHash:hash,archiveHash:digest(await fs.readFile(archive)),archiveBytes:(await fs.stat(archive)).size,restoredVerified:true};
}
function latestRollback(names){return names.filter(name=>/^previous-[a-z0-9-]+-\d{8}-\d{6}\.app$/.test(name)).sort((a,b)=>a.slice(-19).localeCompare(b.slice(-19))).at(-1);}
async function removeBuild(root,name,processes){const app=await validate(await fs.realpath(root),name,processes);await fs.rm(app,{recursive:true});return app;}
function unregister(app){
 const result=spawnSync(lsregister,['-u',app],{encoding:'utf8'}),message=(result.stdout||'')+(result.stderr||'');
 if(result.status!==0&&!message.includes('-10814'))throw new Error('注销失败：'+message);
}
async function main(){
 if(process.platform!=='darwin')throw new Error('仅支持 macOS');
 if(process.argv.length>3||process.argv[2]&&process.argv[2]!=='--apply')throw new Error('用法：node scripts/archive-builds.cjs [--apply]，默认仅预览');
 const root=await fs.realpath(path.join(__dirname,'..')),release=path.join(root,'release'),live=path.join(release,'WorkDay.app');
 if(identity(live)!==bundleId)throw new Error('正式应用标识不匹配');
 const builds=[];for(const name of (await fs.readdir(release)).sort())if(buildName.test(name)){await validate(root,name);builds.push(name);}
 const rollback=latestRollback(builds);
 if(!process.argv[2]){console.log(JSON.stringify({dryRun:true,live,rollback,builds,count:builds.length},null,2));return;}
 if(!builds.length){console.log(JSON.stringify({complete:true,removed:0,live}));return;}
 if(!rollback)throw new Error('没有可验证的最近回滚包，未清理任何副本');
 const before=digest(await tree(live)),receipt=path.join(root,'test-results/build-archives-'+Date.now()+'.json');
 const result={live,retained:null,removed:[],removedArchives:[],complete:false};
 const save=()=>fs.writeFile(receipt,JSON.stringify(result,null,2));
 try{
  unregister(path.join(release,rollback));result.retained=await archiveBuild(root,rollback);await save();console.log(JSON.stringify({retained:result.retained}));
  for(const name of builds)if(name!==rollback){
   unregister(path.join(release,name));result.removed.push(await removeBuild(root,name));await save();console.log(JSON.stringify({removed:name}));
  }
  const directory=path.join(release,'build-archives');
  for(const name of await fs.readdir(directory)){
   const archive=path.join(directory,name);
   if(archive===result.retained.archive||!/^(?:WorkDay(?:-[a-z0-9]+)*-stage|previous-[a-z0-9-]+)\.app-[a-f0-9]{12}-[a-f0-9-]{36}\.zip(?:\.partial)?$/.test(name))continue;
   const s=await fs.lstat(archive);if(s.isSymbolicLink()||!s.isFile())throw new Error('旧归档不是普通文件：'+archive);
   await fs.rm(archive);result.removedArchives.push(archive);await save();
  }
 }finally{execFileSync(lsregister,['-f',live]);}
 if(digest(await tree(live))!==before)throw new Error('正式应用发生变化，请检查');
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',live]);
 Object.assign(result,{complete:true,liveUnchanged:true});await save();
 console.log(JSON.stringify({complete:true,removed:result.removed.length,retained:result.retained.archive,liveUnchanged:true,receipt}));
}
module.exports={archiveBuild,latestRollback,removeBuild};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
