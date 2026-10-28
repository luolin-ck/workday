import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DateTime} from 'luxon';
import {TaskReminders} from '../src/main/task-reminders';
import {atomicWrite} from '../src/main/store';
import type {Task} from '../src/shared/types';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
const task=(id:string,extra:Partial<Task>={}):Task=>({id,title:`合成事项 ${id}`,notes:'',date:'2026-10-19',dueDate:null,projectId:null,priority:'P0',completed:false,completedDate:null,deletedAt:null,version:1,createdAt:'',updatedAt:'',...extra});
async function fixture(tasks:Task[]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workday-reminders-'));dirs.push(dir);
 const file=path.join(dir,'task-reminders.json'),state={tasks,now:DateTime.fromISO('2026-10-19T09:00:00',{zone:'Asia/Shanghai'})};
 const notify=vi.fn(async(_tasks:Task[])=>true);
 const options={tasks:()=>state.tasks,now:()=>state.now,notify};
 return {file,state,notify,options,reminders:await TaskReminders.open(file,options)};
}
describe('P0 desktop reminder delivery',()=>{
 it('only reminds unfinished, undeleted P0 items planned for the current local day in one batch',async()=>{
  const f=await fixture([task('today'),task('also'),task('p1',{priority:'P1'}),task('p2',{priority:'P2'}),task('done',{completed:true}),task('deleted',{deletedAt:'deleted'}),task('future',{date:'2026-10-20'}),task('past',{date:'2026-10-18'}),task('deadline-only',{date:'2026-10-20',dueDate:'2026-10-19'})]);
  await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(1);expect(f.notify.mock.calls[0][0].map(t=>t.id)).toEqual(['today','also']);
 });
 it('deduplicates concurrent checks, edits and restarts on the same day',async()=>{
  const f=await fixture([task('today')]);await Promise.all(Array.from({length:12},()=>f.reminders.check()));
  f.state.tasks=[task('today',{title:'改名',priority:'P1'})];await f.reminders.check();f.state.tasks=[task('today')];await f.reminders.check();
  const restarted=await TaskReminders.open(f.file,f.options);await restarted.check();expect(f.notify).toHaveBeenCalledTimes(1);
  const receipt=await fs.readFile(f.file,'utf8');expect(receipt).not.toContain('合成事项');expect(receipt).not.toContain('改名');
 });
 it('reminds newly upgraded P0 and new items, without notifying lower priorities',async()=>{
  const f=await fixture([task('today',{priority:'P2'})]);await f.reminders.check();expect(f.notify).not.toHaveBeenCalled();
  f.state.tasks=[task('today')];await f.reminders.check();f.state.tasks.push(task('new'));await f.reminders.check();
  expect(f.notify.mock.calls.map(([items])=>items.map(t=>t.id))).toEqual([['today'],['new']]);
 });
 it('uses the local day across UTC midnight, DST and next-day rollover',async()=>{
  const f=await fixture([task('roll')]);f.state.now=DateTime.fromISO('2026-10-19T00:01:00',{zone:'Asia/Shanghai'});await f.reminders.check();
  f.state.now=f.state.now.plus({days:1});f.state.tasks=[task('roll',{date:'2026-10-20'})];await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(2);
  f.state.now=DateTime.fromISO('2026-11-01T01:30:00-04:00',{setZone:true});f.state.tasks=[task('dst',{date:'2026-11-01'})];await f.reminders.check();
  f.state.now=DateTime.fromISO('2026-11-01T01:30:00-05:00',{setZone:true});await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(3);
 });
 it('does not consume failed delivery, throttles retries and rechecks current eligibility',async()=>{
  const f=await fixture([task('today')]);f.notify.mockResolvedValue(false);await f.reminders.check();await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(1);
  await expect(fs.access(f.file)).rejects.toThrow();
  f.state.now=f.state.now.plus({minutes:5});f.notify.mockResolvedValue(true);await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(2);
  const restarted=await TaskReminders.open(f.file,f.options);await restarted.check();expect(f.notify).toHaveBeenCalledTimes(2);
 });
 it('never treats thrown delivery errors as a successful reminder',async()=>{
  const f=await fixture([task('today')]);f.notify.mockRejectedValueOnce(new Error('native failure'));await f.reminders.check();
  f.state.now=f.state.now.plus({minutes:5});f.state.tasks=[task('today',{completed:true})];await f.reminders.check();expect(f.notify).toHaveBeenCalledTimes(1);
 });
 it('retries receipt persistence without showing the same alert again in this process',async()=>{
  const f=await fixture([task('today')]);let fails=true;
  const reminders=await TaskReminders.open(f.file,{...f.options,persist:async(file,data)=>{if(fails)throw new Error('disk');await atomicWrite(file,data);}});
  await expect(reminders.check()).rejects.toThrow('disk');fails=false;await reminders.check();expect(f.notify).toHaveBeenCalledTimes(1);
  const restarted=await TaskReminders.open(f.file,f.options);await restarted.check();expect(f.notify).toHaveBeenCalledTimes(1);
 });
 it('preserves a malformed receipt rather than resetting and repeating alerts',async()=>{
  const f=await fixture([]);await fs.writeFile(f.file,'broken');await expect(TaskReminders.open(f.file,f.options)).rejects.toThrow();expect(await fs.readFile(f.file,'utf8')).toBe('broken');
 });
});
