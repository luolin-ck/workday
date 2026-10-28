const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {buildProjectFiles}=require('./build-project-files.cjs');
const {buildChatAttachments}=require('./build-chat-attachments.cjs');
const {buildImageGif}=require('./build-image-gif.cjs');
const {buildKeychainAccess}=require('./build-keychain-access.cjs');
function validateStage(root,destination,processes=''){
 const release=path.join(root,'release'),resolved=path.resolve(destination);
 if(destination!==resolved||path.dirname(resolved)!==release||!/^WorkDay(?:-[a-z0-9]+)*-stage\.app$/.test(path.basename(resolved)))throw new Error('只能生成 release 下的 WorkDay-*-stage.app，不能覆盖 live 或回滚包');
 if(processes.includes(resolved+'/Contents/'))throw new Error('目标 stage 正在运行，请正常退出后重试');
 return resolved;
}
async function main(){
 if(process.platform!=='darwin')throw new Error('该本地产物脚本仅支持 macOS');
 const root=await fs.realpath(path.resolve(__dirname,'..'));
 if(process.argv.length>3)throw new Error('用法：node scripts/package-mac.cjs [release 中的 stage 绝对路径]');
 const destination=validateStage(root,process.argv[2]??path.join(root,'release','WorkDay-meetings-stage.app'),execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'}));
 const release=path.dirname(destination),icon=path.join(root,'assets','branding','workday.icns');
 await fs.mkdir(release,{recursive:true});
 if(await fs.realpath(release)!==release)throw new Error('release 不能是符号链接');
 try{if((await fs.lstat(destination)).isSymbolicLink())throw new Error('stage 不能是符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.access(path.join(root,'dist','main','index.js'));await fs.access(path.join(root,'dist','renderer','index.html'));await fs.access(icon);
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'workday-calendar-build-'));
 try{
  const binary=path.join(temporary,'calendar-events');
  const projectFiles=await buildProjectFiles(path.join(temporary,'project-files'));
  const chatAttachments=await buildChatAttachments(path.join(temporary,'chat-attachments'));
  const imageGif=await buildImageGif(path.join(temporary,'image-gif'));
  const keychainAccess=await buildKeychainAccess(path.join(temporary,'keychain-access'));
  const sdk=execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{encoding:'utf8'}).trim();
  const swift=execFileSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'}).trim();
  execFileSync(swift,['-sdk',sdk,'-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx12.0`,'-O','-module-cache-path',path.join(temporary,'modules'),path.join(root,'native/calendar-events.swift'),'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',path.join(root,'native/calendar-events-Info.plist'),'-o',binary],{stdio:'inherit'});
  // Validate again immediately before replacing the explicitly named stage.
  validateStage(root,destination,execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'}));
  await fs.rm(destination,{recursive:true,force:true});
  await fs.cp(path.join(root,'node_modules/electron/dist/Electron.app'),destination,{recursive:true,verbatimSymlinks:true});
  await fs.copyFile(icon,path.join(destination,'Contents/Resources/workday.icns'));
  const resource=path.join(destination,'Contents/Resources/app');await fs.mkdir(resource,{recursive:true});
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  await fs.writeFile(path.join(resource,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,main:pkg.main,dependencies:pkg.dependencies},null,2));
  await fs.cp(path.join(root,'dist'),path.join(resource,'dist'),{recursive:true,verbatimSymlinks:true});
  await fs.mkdir(path.join(resource,'native'),{recursive:true});await fs.copyFile(binary,path.join(resource,'native/calendar-events'));await fs.copyFile(projectFiles,path.join(resource,'native/project-files'));await fs.copyFile(chatAttachments,path.join(resource,'native/chat-attachments'));await fs.copyFile(keychainAccess,path.join(resource,'native/keychain-access'));await fs.copyFile(imageGif,path.join(resource,'native/image-gif'));
  const npm=process.env.npm_execpath||path.join(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');let output;
  try{output=execFileSync(process.execPath,[npm,'ls','--omit=dev','--all','--parseable'],{cwd:root,encoding:'utf8'});}catch(error){if(!error.stdout)throw error;output=error.stdout.toString();}
  const dirs=output.trim().split('\n').filter(p=>p.startsWith(path.join(root,'node_modules')+path.sep));
  for(const dir of dirs){const relative=path.relative(root,dir);await fs.mkdir(path.dirname(path.join(resource,relative)),{recursive:true});await fs.cp(dir,path.join(resource,relative),{recursive:true,verbatimSymlinks:true});}
  const plist=path.join(destination,'Contents/Info.plist');
  for(const [key,value] of Object.entries({CFBundleName:'WorkDay',CFBundleDisplayName:'WorkDay',CFBundleIdentifier:'local.workday.desktop',CFBundleShortVersionString:pkg.version,CFBundleVersion:pkg.version,CFBundleIconFile:'workday.icns'}))execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
  const permission='只读取「我的日历（钉钉）」中的会议，显示在 WorkDay 月历中。不会修改日历或发送给 AI。';
  for(const key of ['NSCalendarsFullAccessUsageDescription','NSCalendarsUsageDescription'])execFileSync('/usr/libexec/PlistBuddy',['-c',`Add :${key} string ${permission}`,plist]);
  await fs.rm(path.join(destination,'Contents/Resources/default_app.asar'),{force:true});
  for(const helper of ['calendar-events','project-files','chat-attachments','keychain-access','image-gif'])execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(resource,'native',helper)],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',destination],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',destination],{stdio:'inherit'});
  console.log('macOS stage 已生成：'+destination+'（临时签名，未商业签名或公证）');
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
module.exports={validateStage};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
