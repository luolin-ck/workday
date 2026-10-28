import {describe,it,expect} from 'vitest';
import {calendarSchedules,nextSlot,slotFor} from '../src/shared/dates';
import {spec as specSchema} from '../src/main/validation';
import {emptyContext,type Schedule,type ScheduleRun,type ScheduleSpec} from '../src/shared/types';

const biweekly:ScheduleSpec={kind:'biweekly',startDate:'2026-12-25',time:'09:00',timezone:'Asia/Shanghai'};
const schedule=(id:string,changes:Partial<Schedule>={}):Schedule=>({id,name:id,version:1,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',prompt:'fixture',projectId:null,model:{sourceId:'source',modelId:'mock'},context:emptyContext(),spec:biweekly,enabled:true,status:'active',pauseReason:null,nextRunAt:'2026-12-25T01:00:00Z',nextSlot:null,sourceVersion:1,...changes});
const run=(scheduleId:string,scheduledFor:string,changes:Partial<ScheduleRun>={}):ScheduleRun=>({id:`${scheduleId}/${scheduledFor}`,scheduleId,triggerType:'auto',triggerId:null,scheduledFor,startedAt:scheduledFor,endedAt:scheduledFor,status:'success',conversationId:null,error:null,model:{sourceId:'source',modelId:'mock'},...changes});
const project=(s:Schedule[],r:ScheduleRun[]=[],now='2026-12-01T00:00:00Z',zone='Asia/Shanghai')=>calendarSchedules(s,r,'2026-12-01','2027-01-11',now,zone);

describe('shared schedule dates',()=>{
 it('keeps the first civil day as the biweekly anchor across years and exact boundaries',()=>{
  expect(nextSlot(biweekly,'2026-01-01T00:00:00Z')?.at).toBe('2026-12-25T01:00:00.000Z');
  expect(nextSlot(biweekly,'2026-12-25T00:59:59.999Z')?.key).toContain('2026-12-25');
  expect(nextSlot(biweekly,'2026-12-25T01:00:00.000Z')?.key).toContain('2027-01-08');
  expect(nextSlot(biweekly,'2027-01-09T00:00:00Z')?.key).toContain('2027-01-22');
  expect(nextSlot({...biweekly,startDate:'2030-01-01'},'2026-01-01T00:00:00Z')?.key).toContain('2030-01-01');
  expect(nextSlot({...biweekly,startDate:'2028-02-15'},'2028-02-15T01:00:00Z')?.key).toContain('2028-02-29');
 });
 it('uses civil weeks across DST and preserves fold/gap scheduler semantics',()=>{
  const spring:ScheduleSpec={kind:'biweekly',startDate:'2026-02-22',time:'02:30',timezone:'America/New_York'};
  const gap=nextSlot(spring,'2026-02-22T07:30:00Z')!;
  expect(gap).toMatchObject({key:'2026-03-08T02:30[America/New_York]',gap:true});
  expect(nextSlot(spring,gap.at)?.at).toBe('2026-03-22T06:30:00.000Z');
  const fall:ScheduleSpec={kind:'biweekly',startDate:'2026-10-18',time:'01:30',timezone:'America/New_York'};
  expect(nextSlot(fall,'2026-10-18T05:30:00Z')?.at).toBe('2026-11-01T05:30:00.000Z');
  expect(nextSlot(fall,'2026-11-01T05:30:00Z')?.at).toBe('2026-11-15T06:30:00.000Z');
  expect(slotFor(fall,'2026-11-01').gap).toBe(false);
 });
 it.each([
  {startDate:'2026-02-30'}, {startDate:'2026-2-01'}, {startDate:''}, {time:'25:00'}, {timezone:'Invalid/Zone'}, {weekday:1}
 ])('rejects malformed or extra biweekly fields %j',changes=>expect(specSchema.safeParse({...biweekly,...changes}).success).toBe(false));
 it('keeps the three existing spec forms valid',()=>{
  for(const value of [{kind:'once',date:'2027-01-01'}, {kind:'daily'}, {kind:'weekly',weekday:3}])expect(specSchema.safeParse({...value,time:'09:00',timezone:'Asia/Shanghai'}).success).toBe(true);
 });
});

describe('calendar schedule projection',()=>{
 it('projects every anchored date in the visible range and aggregates distinct schedules',()=>{
  const days=project([schedule('双周报'),schedule('复盘')]);
  expect([...days.keys()]).toEqual(['2026-12-25','2027-01-08']);
  expect(days.get('2027-01-08')?.map(v=>v.scheduleId).sort()).toEqual(['双周报','复盘']);
  expect(days.get('2026-12-25')?.every(v=>v.status==='scheduled')).toBe(true);
 });
 it('respects active, nextRunAt, createdAt and now inclusive boundaries',()=>{
  expect(project([schedule('paused',{enabled:false,status:'paused'}),schedule('inconsistent',{status:'paused'}),schedule('no-slot',{nextRunAt:null})]).size).toBe(0);
  expect([...project([schedule('later',{nextRunAt:'2027-01-08T01:00:00Z'})]).keys()]).toEqual(['2027-01-08']);
  expect([...project([schedule('created-later',{createdAt:'2026-12-26T00:00:00Z'})]).keys()]).toEqual(['2027-01-08']);
  expect([...project([schedule('now')],[],'2026-12-25T01:00:00Z').keys()]).toEqual(['2026-12-25','2027-01-08']);
  expect([...project([schedule('past')],[],'2026-12-25T01:00:00.001Z').keys()]).toEqual(['2027-01-08']);
 });
 it('only records real automatic history, ignores manual/orphan/creation-preceding records, and deduplicates slots',()=>{
  const s=schedule('history',{enabled:false,status:'paused',createdAt:'2026-12-05T00:00:00Z'});
  const r=run(s.id,'2026-12-11T01:00:00Z');
  const days=project([s],[r,r,run(s.id,'2026-12-02T01:00:00Z'),run(s.id,'2026-12-12T01:00:00Z',{triggerType:'manual'}),run('orphan',r.scheduledFor!),run(s.id,'not-a-date')],'2026-12-20T00:00:00Z');
  expect([...days.keys()]).toEqual(['2026-12-11']);expect(days.get('2026-12-11')).toHaveLength(1);
  expect(project([{...s,spec:{kind:'daily',time:'15:00',timezone:'UTC'}}],[r],'2026-12-20T00:00:00Z').get('2026-12-11')?.[0].at).toBe('2026-12-11T01:00:00.000Z');
  expect(project([schedule('boundary')],[run('boundary','2026-12-25T01:00:00Z')],'2026-12-25T01:00:00Z').get('2026-12-25')).toHaveLength(1);
 });
 it('uses the calendar timezone at midnight and both ends of its date range',()=>{
  const s=schedule('late',{spec:{kind:'once',date:'2026-12-31',time:'23:30',timezone:'America/Los_Angeles'},nextRunAt:'2027-01-01T07:30:00Z'});
  expect(project([s]).get('2027-01-01')?.[0].at).toBe('2027-01-01T07:30:00.000Z');
  expect(project([s],[],'2026-12-01T00:00:00Z','America/Los_Angeles').has('2026-12-31')).toBe(true);
  const midnight=schedule('midnight',{spec:{kind:'daily',time:'00:00',timezone:'Asia/Shanghai'},nextRunAt:'2026-11-30T16:00:00Z'});
  const days=project([midnight],[],'2026-11-30T16:00:00Z');expect(days.size).toBe(42);expect(days.has('2026-12-01')).toBe(true);expect(days.has('2027-01-11')).toBe(true);expect(days.has('2027-01-12')).toBe(false);
 });
 it('omits future DST gaps, retains actual missed records and completed once history',()=>{
  const s=schedule('gap',{spec:{kind:'biweekly',startDate:'2026-02-22',time:'02:30',timezone:'America/New_York'},createdAt:'2026-01-01T00:00:00Z',nextRunAt:'2026-02-22T07:30:00Z'});
  const days=calendarSchedules([s],[],'2026-02-22','2026-03-31','2026-02-22T07:30:00Z','America/New_York');
  expect([...days.keys()]).toEqual(['2026-02-22','2026-03-22']);
  const missed=run(s.id,'2026-03-08T07:30:00Z',{status:'missed',error:'夏令时造成该当地时间不存在'});
  const historical=calendarSchedules([{...s,enabled:false,status:'paused'}],[missed],'2026-03-01','2026-03-31','2026-03-09T00:00:00Z','America/New_York');
  expect(historical.get('2026-03-08')?.[0]).toMatchObject({status:'missed',gap:true});
  const once=schedule('once',{spec:{kind:'once',date:'2026-12-25',time:'09:00',timezone:'Asia/Shanghai'},enabled:false,status:'completed',nextRunAt:null});
  expect([...project([once],[run(once.id,'2026-12-25T01:00:00Z')],'2027-01-01T00:00:00Z').keys()]).toEqual(['2026-12-25']);
 });
});
