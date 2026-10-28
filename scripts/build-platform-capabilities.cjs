const fs=require('node:fs/promises');
const path=require('node:path');
async function build(){const root=path.resolve(__dirname,'..');const source=path.join(root,'src/main/platform-capabilities'),destination=path.join(root,'dist/main/platform-capabilities');await fs.mkdir(path.dirname(destination),{recursive:true});await fs.rm(destination,{recursive:true,force:true});await fs.rm(path.join(root,'dist/main/builtin-skills'),{recursive:true,force:true});await fs.cp(source,destination,{recursive:true});await fs.copyFile(path.join(root,'src/main/component-descriptions.zh.json'),path.join(root,'dist/main/component-descriptions.zh.json'));}
module.exports={build};
if(require.main===module)build().catch(e=>{console.error(e);process.exitCode=1;});
