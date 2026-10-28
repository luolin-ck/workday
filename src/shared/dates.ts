import {DateTime} from 'luxon';
import type {Meeting, Schedule, ScheduleRun, ScheduleSpec, Task} from './types';
type CompletionRecord=Pick<Task,'completed'|'date'> & {completedDate?:string|null};
export function taskCalendarDate(task:CompletionRecord):string {
 return task.completed?task.completedDate??task.date:task.date;
}
export function taskCompletionDate(completed:boolean,previous?:CompletionRecord,selected?:string|null):string|null {
 if(!completed)return null;
 return selected??(previous?.completed?taskCalendarDate(previous):DateTime.local().toISODate()!);
}
export function priorityReminderTasks(tasks:Task[],day:string):Task[] {
 return tasks.filter(task=>task.priority==='P0'&&task.date===day&&!task.completed&&!task.deletedAt);
}
export interface Slot {at:string;key:string;gap:boolean}
export function slotFor(spec:ScheduleSpec,day:string):Slot {
 const [hour,minute]=spec.time.split(':').map(Number);const [year,month,date]=day.split('-').map(Number);
 const d=DateTime.fromObject({year,month,day:date,hour,minute},{zone:spec.timezone});
 const gap=d.toISODate()!==day||d.hour!==hour||d.minute!==minute;
 const possible=d.getPossibleOffsets();const early=possible.reduce((a,b)=>a.toMillis()<b.toMillis()?a:b,d);
 return {at:early.toUTC().toISO()!,key:`${day}T${spec.time}[${spec.timezone}]`,gap};
}
export function nextSlot(spec:ScheduleSpec,after:string):Slot|null {
 if(spec.kind==='once'){const s=slotFor(spec,spec.date);return DateTime.fromISO(s.at).toMillis()>DateTime.fromISO(after).toMillis()?s:null;}
 let day=DateTime.fromISO(after,{zone:spec.timezone}).startOf('day');
 if(spec.kind==='biweekly'){
  const start=DateTime.fromISO(spec.startDate,{zone:spec.timezone}).startOf('day');
  const cycles=Math.max(0,Math.floor(day.diff(start,'days').days/14));
  day=start.plus({days:cycles*14});
  const slot=slotFor(spec,day.toISODate()!);
  return DateTime.fromISO(slot.at).toMillis()>DateTime.fromISO(after).toMillis()?slot:slotFor(spec,day.plus({days:14}).toISODate()!);
 }
 for(let n=0;n<370;n++,day=day.plus({days:1})){if(spec.kind==='weekly'&&day.weekday!==spec.weekday)continue;const s=slotFor(spec,day.toISODate()!);if(DateTime.fromISO(s.at).toMillis()>DateTime.fromISO(after).toMillis())return s;}
 return null;
}

export interface CalendarSchedule {scheduleId:string;name:string;at:string;timezone:string;status:ScheduleRun['status']|'scheduled';gap:boolean}
export function calendarSchedules(schedules:Schedule[],runs:ScheduleRun[],firstDay:string,lastDay:string,now:string,timezone:string):Map<string,CalendarSchedule[]> {
 const result=new Map<string,CalendarSchedule[]>(),seen=new Set<string>();
 const start=DateTime.fromISO(firstDay,{zone:timezone}).startOf('day').toMillis();
 const end=DateTime.fromISO(lastDay,{zone:timezone}).plus({days:1}).startOf('day').toMillis();
 const current=DateTime.fromISO(now).toMillis();
 if(![start,end,current].every(Number.isFinite)||end<=start)return result;
 const byId=new Map(schedules.map(schedule=>[schedule.id,schedule]));
 function add(schedule:Schedule,at:string,status:CalendarSchedule['status'],gap=false){
  const instant=DateTime.fromISO(at),millis=instant.toMillis(),key=`${schedule.id}/${millis}`;
  if(!instant.isValid||millis<start||millis>=end||seen.has(key))return;
  seen.add(key);
  const day=instant.setZone(timezone).toISODate()!;
  const entries=result.get(day)??[];
  entries.push({scheduleId:schedule.id,name:schedule.name,at:instant.toUTC().toISO()!,timezone:schedule.spec.timezone,status,gap});result.set(day,entries);
 }
 for(const run of runs){
  const schedule=byId.get(run.scheduleId),at=run.scheduledFor?DateTime.fromISO(run.scheduledFor).toMillis():NaN;
  if(schedule&&run.triggerType==='auto'&&at<=current&&at>=DateTime.fromISO(schedule.createdAt).toMillis())add(schedule,run.scheduledFor!,run.status,run.error?.includes('夏令时')??false);
 }
 for(const schedule of schedules){
  if(!schedule.enabled||schedule.status!=='active'||!schedule.nextRunAt)continue;
  const lower=Math.max(start,current,DateTime.fromISO(schedule.nextRunAt).toMillis(),DateTime.fromISO(schedule.createdAt).toMillis());
  if(!Number.isFinite(lower)||lower>=end)continue;
  // nextSlot is strictly after; subtract 1 ms so an execution exactly at the range boundary is included.
  let slot=nextSlot(schedule.spec,DateTime.fromMillis(lower-1).toISO()!);
  while(slot&&DateTime.fromISO(slot.at).toMillis()<end){
   if(!slot.gap)add(schedule,slot.at,'scheduled');
   slot=nextSlot(schedule.spec,slot.at);
  }
 }
 for(const entries of result.values())entries.sort((a,b)=>a.at.localeCompare(b.at)||a.name.localeCompare(b.name));
 return result;
}

export function meetingRange(month:string,timezone:string) {
 const first=DateTime.fromISO(month,{zone:timezone}).startOf('month');
 const start=first.minus({days:first.weekday%7});
 return {startDate:start.toISODate()!,endDate:start.plus({days:42}).toISODate()!,timezone};
}

export function calendarMeetings(meetings:Meeting[],startDate:string,endDate:string,timezone:string):Map<string,Meeting[]> {
 const result=new Map<string,Meeting[]>();
 const unique=[...new Map(meetings.map(meeting=>[`${meeting.id}/${meeting.start}`,meeting])).values()];
 for(let day=DateTime.fromISO(startDate,{zone:timezone}),count=0;day.isValid&&day.toISODate()!<endDate&&count<42;day=day.plus({days:1}),count++){
  const key=day.toISODate()!,next=day.plus({days:1});
  const entries=unique.filter(meeting=>meeting.allDay
   ? meeting.startDate!==null&&meeting.endDate!==null&&meeting.startDate<=key&&meeting.endDate>key
   : DateTime.fromISO(meeting.start).toMillis()<next.toMillis()&&DateTime.fromISO(meeting.end).toMillis()>day.toMillis());
  entries.sort((a,b)=>Number(b.allDay)-Number(a.allDay)||DateTime.fromISO(a.start).toMillis()-DateTime.fromISO(b.start).toMillis()||a.title.localeCompare(b.title));
  if(entries.length)result.set(key,entries);
 }
 return result;
}
