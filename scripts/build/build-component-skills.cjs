// Compatibility entrypoint for existing local verification scripts.
const {build}=require('./build-platform-capabilities.cjs');
module.exports={build};
if(require.main===module)build().catch(e=>{console.error(e);process.exitCode=1;});
