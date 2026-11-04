const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function prepare(snapshotFile,inventoryFile,preparationFile,output){
 const snapshot=JSON.parse(await fs.readFile(snapshotFile,'utf8')),inventory=JSON.parse(await fs.readFile(inventoryFile,'utf8')),preparation=JSON.parse(await fs.readFile(preparationFile,'utf8'));
 if(snapshot.items.length!==113||inventory.skillCount!==110||inventory.pluginCount!==6||!inventory.allExpectedContentMatched)throw new Error('Expected frozen 113-source / 110-skill / 6-package input');
 const old=new Map(preparation.packages.flatMap(p=>p.skills.map(s=>[p.pluginKey+'/'+s.catalogName,s])));
 const legacy={plugins:inventory.plugins.map(({id,pluginKey,version,skillIds,mcpIds,enabled})=>({id,pluginKey,version,skillIds,mcpIds,enabled})),skills:inventory.skills.map(s=>{const record=old.get(s.name);if(!record||record.contentSha256!==s.contentSha256||!s.contentMatchesExpected||!s.descriptionMatchesExpected)throw new Error('Legacy fingerprint differs');return {id:s.id,name:s.name,version:s.version,ownerPluginId:s.ownerPluginId,enabled:s.enabled,contentSha256:s.contentSha256,descriptionSha256:sha(record.description)};})};
 const previous=new Map(legacy.skills.map(s=>[s.name.replace(/^codex-skills-0[1-6]\//,''),s.id])),groups=new Map();
 for(const item of snapshot.items){if(/\bjev\b/i.test(item.catalogName))throw new Error('Jev is paused');const bytes=await fs.readFile(item.sourceFile);if(sha(bytes)!==item.sourceSha256)throw new Error('Source changed since the frozen catalog: '+item.catalogName);let root=item.sourceDirectory,owner=null;
  while(root!==path.dirname(root)){
   try{const portable=JSON.parse(await fs.readFile(path.join(root,'plugin.json'),'utf8'));if(portable.$schema==='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'){owner=root;break;}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
   try{await fs.access(path.join(root,'.codex-plugin','plugin.json'));owner=root;break;}catch(error){if(error.code!=='ENOENT')throw error;}
   root=path.dirname(root);
  }
  const source=owner??item.sourceDirectory,key=(owner?'plugin:':'skill:')+source;if(!groups.has(key))groups.set(key,{kind:owner?'plugin':'skill',root:source,entries:[]});const entry=path.relative(source,item.sourceFile).split(path.sep).join('/'),legacyId=previous.get(item.catalogName);groups.get(key).entries.push({entry,...(legacyId?{legacyId}:{})});
 }
 const input={format:'WorkDay components migration',version:1,legacy,sources:[...groups.values()]};
 if(input.sources.flatMap(s=>s.entries).filter(e=>e.legacyId).length!==110)throw new Error('Mapping incomplete');
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(input,null,2),{flag:'wx',mode:0o600});return {output,sha256:sha(await fs.readFile(output)),sources:input.sources.length,plugins:input.sources.filter(s=>s.kind==='plugin').length,skills:113,preserved:110,added:3};
}
module.exports={prepare};
if(require.main===module){if(process.argv.length!==6)throw new Error('Usage: node prepare-component-migration.cjs snapshot.json inventory.json preparation.json output.json');prepare(...process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});}
