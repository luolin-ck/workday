import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
it.skipIf(process.platform!=='darwin')('executes the same Swift ACL policy against in-memory SecAccess and synthetic arrays without opening a keychain',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workday-keychain-policy-'));
 try{
  const output=execFileSync('/usr/bin/xcrun',['swift','-D','KEYCHAIN_FIXTURE','-module-cache-path',path.join(directory,'modules'),path.resolve('native/keychain-access.swift')],{encoding:'utf8',timeout:120000,maxBuffer:64*1024});
  expect(output).not.toContain('FAIL');expect(output.split('\n').filter(line=>line.startsWith('PASS'))).toHaveLength(42);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
},140000);
