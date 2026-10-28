import { describe, expect, it } from 'vitest';
import * as dates from '../src/shared/dates';

const meeting = (id:string,start:string,end:string,extra={}) => ({id,title:`合成会议 ${id}`,start,end,allDay:false,startDate:null,endDate:null,...extra});
describe('meeting calendar projection', () => {
  it('uses the same 42 civil days across a DST transition', () => {
    expect(dates.meetingRange('2026-03-15','America/New_York')).toEqual({startDate:'2026-03-01',endDate:'2026-04-12',timezone:'America/New_York'});
    expect(dates.meetingRange('2026-10-15','Asia/Shanghai')).toEqual({startDate:'2026-09-27',endDate:'2026-11-08',timezone:'Asia/Shanghai'});
  });
  it('projects timed events by display timezone with an exclusive midnight end', () => {
    const entries=[meeting('night','2026-10-15T15:00:00Z','2026-10-16T00:00:00+08:00'),meeting('multi','2026-10-15T23:30:00+08:00','2026-10-17T08:00:00+08:00')];
    const result=dates.calendarMeetings(entries,'2026-10-15','2026-10-18','Asia/Shanghai');
    expect([...result].map(([day,items])=>[day,items.map(item=>item.id)])).toEqual([['2026-10-15',['night','multi']],['2026-10-16',['multi']],['2026-10-17',['multi']]]);
  });
  it('keeps all-day civil dates independent of viewer timezone and deduplicates instances', () => {
    const allDay=meeting('day','2026-10-14T15:00:00Z','2026-10-16T15:00:00Z',{allDay:true,startDate:'2026-10-15',endDate:'2026-10-17'});
    const first=meeting('series','2026-10-15T12:00:00Z','2026-10-15T13:00:00Z'),second=meeting('series','2026-10-16T12:00:00Z','2026-10-16T13:00:00Z');
    const result=dates.calendarMeetings([first,allDay,first,second],'2026-10-15','2026-10-18','America/Los_Angeles');
    expect([...result].map(([day,items])=>[day,items.map(item=>item.id)])).toEqual([['2026-10-15',['day','series']],['2026-10-16',['day','series']]]);
  });
  it('clips multi-day meetings to the range without skipping a DST day', () => {
    const result=dates.calendarMeetings([meeting('dst','2026-03-07T23:00:00-05:00','2026-03-09T00:00:00-04:00')],'2026-03-08','2026-03-10','America/New_York');
    expect([...result.keys()]).toEqual(['2026-03-08']);
    expect(dates.calendarMeetings([meeting('outside','2026-03-10T00:00:00-04:00','2026-03-10T01:00:00-04:00')],'2026-03-08','2026-03-10','America/New_York').size).toBe(0);
  });
  it('orders timed meetings by instant even when offsets differ',()=>{
    const result=dates.calendarMeetings([meeting('later','2026-10-15T09:00:00Z','2026-10-15T10:00:00Z'),meeting('earlier','2026-10-15T10:00:00+08:00','2026-10-15T11:00:00+08:00')],'2026-10-15','2026-10-16','Asia/Shanghai');
    expect(result.get('2026-10-15')?.map(item=>item.id)).toEqual(['earlier','later']);
  });
});
