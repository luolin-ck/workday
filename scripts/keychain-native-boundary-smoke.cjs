const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
const {_electron}=require(process.env.WORKDAY_PLAYWRIGHT_MODULE||'playwright');const {launchWithWeatherFixture}=require('./electron-fixture-launch.cjs');
async function main(){
 if(!process.env.WORKDAY_ELECTRON_EXECUTABLE)throw new Error('This boundary test requires an explicit stage executable');
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'workday-keychain-boundary-')),env={...process.env,WORKDAY_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;let app;
 try{
  app=await launchWithWeatherFixture(_electron,{executablePath:process.env.WORKDAY_ELECTRON_EXECUTABLE,args:[],env,timeout:30000},{mockHolidays:true,keychain:true});
  await app.firstWindow();
  const result=await app.evaluate(async()=>await globalThis.__keychainNativeBoundary());
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.signal,null);assert.equal(JSON.parse(result.stdout).status,'unsupportedPackage');
  const output=path.resolve(__dirname,'../output/playwright/keychain-stage/native-boundary.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({passed:true,result,dataDirectory:data,realCredentialReads:0,realKeychainItemReads:0,realKeychainWrites:0},null,2));console.log(JSON.stringify({passed:true,result,output},null,2));
 }finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
