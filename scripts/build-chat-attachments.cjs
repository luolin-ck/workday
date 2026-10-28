const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {constants}=require('node:fs');
const {execFileSync}=require('node:child_process');
async function buildChatAttachments(destination){
 if(process.platform!=='darwin')throw new Error('聊天附件转换原生程序仅支持 macOS');
 const root=path.resolve(__dirname,'..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'workday-attachments-build-'));
 try{
  const sdk=execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{encoding:'utf8'}).trim(),swift=execFileSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'}).trim(),binary=path.join(temporary,'chat-attachments');
  execFileSync(swift,['-sdk',sdk,'-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx12.0`,'-O','-module-cache-path',path.join(temporary,'modules'),path.join(root,'native/chat-attachments.swift'),'-o',binary],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--force','--sign','-',binary],{stdio:'inherit'});
  await fs.mkdir(path.dirname(destination),{recursive:true});
  const staged=path.join(path.dirname(destination),'.chat-attachments-'+randomUUID());
  try{await fs.copyFile(binary,staged,constants.COPYFILE_EXCL);await fs.chmod(staged,0o755);await fs.rename(staged,destination);}finally{await fs.rm(staged,{force:true});}
  return destination;
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
module.exports={buildChatAttachments};
if(require.main===module){if(process.argv.length>2)throw new Error('用法：node scripts/build-chat-attachments.cjs');buildChatAttachments(path.resolve(__dirname,'../native/chat-attachments')).catch(error=>{console.error(error.message);process.exitCode=1;});}
