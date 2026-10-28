import {describe,expect,it,vi} from 'vitest';
import {schemas} from '../src/main/schemas';
import {OPERATIONS} from '../src/shared/api';
import {Meetings} from '../src/main/meetings';

const range={startDate:'2026-09-27',endDate:'2026-11-08',timezone:'Asia/Shanghai'};
describe('read-only calendar meeting boundary',()=>{
 it('registers the bounded query in IPC',()=>{
  expect(OPERATIONS).toContain('meetings.query');
  expect(schemas['meetings.query']?.safeParse(range).success).toBe(true);
 });
 it('accepts exactly 42 civil days across DST and rejects invalid ranges or injected selectors',()=>{
  expect(schemas['meetings.query']?.safeParse({startDate:'2026-10-01',endDate:'2026-11-12',timezone:'America/New_York',requestAccess:true}).success).toBe(true);
  for(const input of [{...range,endDate:'2026-11-09'},{...range,endDate:range.startDate},{...range,endDate:'2026-09-26'},{...range,startDate:'2026-02-30'},{...range,timezone:'Not/AZone'},{...range,timezone:'UTC+8'},{...range,calendarName:'other'},{...range,command:'/bin/sh'},{...range,requestAccess:'true'}])
   expect(schemas['meetings.query']?.safeParse(input).success).toBe(false);
 });
});

const meeting={id:'series/2026-10-16T01:00:00Z',title:'合成测试会议',start:'2026-10-16T01:00:00Z',end:'2026-10-16T02:00:00Z',allDay:false,startDate:null,endDate:null};
describe('native meeting response',()=>{
 it('uses a fixed helper with bounded execution and asks access only explicitly',async()=>{
  const runner=vi.fn(async()=>JSON.stringify({status:'ready',meetings:[meeting]}));
  const reader=new Meetings(runner,'darwin');
  expect(await reader.query(range)).toEqual({...range,status:'ready',meetings:[meeting],message:null});
  const [file,args,options]=runner.mock.calls[0] as unknown as [string,string[],any];
  expect(file.endsWith('/native/calendar-events')).toBe(true);
  expect(args).toEqual([range.startDate,range.endDate,range.timezone,'false']);
  expect(options).toMatchObject({timeout:20000,maxBuffer:524288});
  await reader.query({...range,requestAccess:true});
  expect((runner.mock.calls[1] as any)[1][3]).toBe('true');
 });
 it.each(['notDetermined','denied','restricted','notFound','ambiguous','unsupported','error'])('returns safe %s without stale events or native private error text',async status=>{
  const reader=new Meetings(async()=>JSON.stringify({status,meetings:[meeting]}),'darwin');
  const result=await reader.query(range);
  expect(result.status).toBe(status);expect(result.meetings).toEqual([]);expect(result.message).toBeTruthy();
 });
 it('does not invoke a helper outside macOS or for an invalid request',async()=>{
  const runner=vi.fn();
  expect((await new Meetings(runner,'linux').query(range)).status).toBe('unsupported');expect(runner).not.toHaveBeenCalled();
  await expect(new Meetings(runner,'darwin').query({...range,endDate:'2026-12-30'})).rejects.toThrow('参数');expect(runner).not.toHaveBeenCalled();
 });
 it.each(['not-json','x'.repeat(524289),JSON.stringify({status:'ready',meetings:[{...meeting,notes:'not allowed'}]}),JSON.stringify({status:'ready',meetings:[{...meeting,end:meeting.start}]}),JSON.stringify({status:'ready',meetings:[{...meeting,allDay:true}]}),JSON.stringify({status:'ready',meetings:[{...meeting,start:'2026-10-16T09:00:00'}]}),JSON.stringify({status:'ready',meetings:Array(2001).fill(meeting)})])('rejects malformed or oversized native output without echoing content',async raw=>{
  const result=await new Meetings(async()=>raw,'darwin').query(range);
  expect(result).toMatchObject({status:'error',meetings:[]});expect(result.message).not.toContain('not allowed');
 });
 it('handles native failure without exposing command/stderr and rereads without caching',async()=>{
  const runner=vi.fn().mockRejectedValueOnce(new Error('PRIVATE_STDERR')).mockResolvedValueOnce(JSON.stringify({status:'ready',meetings:[meeting]})).mockResolvedValueOnce(JSON.stringify({status:'ready',meetings:[]}));
  const reader=new Meetings(runner,'darwin');
  expect(await reader.query(range)).toMatchObject({status:'error',meetings:[]});
  expect((await reader.query(range)).meetings).toHaveLength(1);expect((await reader.query(range)).meetings).toEqual([]);expect(runner).toHaveBeenCalledTimes(3);
 });
 it('deduplicates occurrences, sorts events, and accepts explicit all-day civil boundaries',async()=>{
  const allDay={...meeting,id:'all-day',start:'2026-10-15T16:00:00Z',end:'2026-10-17T16:00:00Z',allDay:true,startDate:'2026-10-16',endDate:'2026-10-18'};
  const result=await new Meetings(async()=>JSON.stringify({status:'ready',meetings:[meeting,meeting,allDay]}),'darwin').query(range);
  expect(result.meetings).toEqual([allDay,meeting]);
 });
});
