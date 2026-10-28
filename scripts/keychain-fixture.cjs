function installKeychainFixture(KeychainAccess,safeStorage,nativeHelper){
 const childProcess=require('node:child_process');
 const state=globalThis.__keychainFixture={statusCalls:0,configureCalls:0,openCalls:0,nativeCalls:0,credentialCalls:0,installedBeforeEntry:true,result:{status:'listed',signing:'adhoc',canConfigure:true,message:'访问列表已包含 WorkDay。如仍弹窗，可重新配置。'}};
 globalThis.__keychainNativeBoundary=()=>new Promise(resolve=>childProcess.execFile(nativeHelper,['configure'],{timeout:15000,maxBuffer:4096,encoding:'utf8'},(error,stdout)=>resolve({code:error?.code??0,signal:error?.signal??null,stdout})));
 for(const method of ['isEncryptionAvailable','encryptString','decryptString'])safeStorage[method]=()=>{state.credentialCalls++;throw new Error('Real credentials disabled in keychain fixture');};
 KeychainAccess.prototype.status=async function(){state.statusCalls++;return {...state.result};};
 KeychainAccess.prototype.configure=async function(){state.configureCalls++;await new Promise(resolve=>setTimeout(resolve,250));return {...state.result,status:state.configureCalls===1?'cancelled':'updated',message:state.configureCalls===1?'已取消配置，可随时重试。':'已更新钥匙串访问设置。'};};
 KeychainAccess.prototype.open=async function(){state.openCalls++;return true;};
}
module.exports={installKeychainFixture};
