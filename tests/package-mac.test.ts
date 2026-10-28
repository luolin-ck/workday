import {describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
const {validateStage}=createRequire(import.meta.url)('../scripts/package-mac.cjs');
describe('macOS stage destination safety',()=>{
 const root='/project/WorkDay';
 it('accepts only a named stage directly in release',()=>{
  expect(validateStage(root,root+'/release/WorkDay-meetings-stage.app')).toBe(root+'/release/WorkDay-meetings-stage.app');
 });
 it.each(['/project/WorkDay/release/WorkDay.app','/project/WorkDay/release/previous-stage.app','/project/WorkDay/release/Other.app','/project/WorkDay/release/WorkDay-stage.app/child','/tmp/WorkDay-stage.app','/project/WorkDay/release/../WorkDay-stage.app'])('rejects deleting an unsafe destination %s',destination=>{
  expect(()=>validateStage(root,destination)).toThrow();
 });
 it('refuses to replace a running stage and ignores unrelated processes',()=>{
  const destination=root+'/release/WorkDay-meetings-stage.app';
  expect(()=>validateStage(root,destination,destination+'/Contents/MacOS/Electron')).toThrow('运行');
  expect(validateStage(root,destination,root+'/release/WorkDay.app/Contents/MacOS/Electron')).toBe(destination);
 });
});
