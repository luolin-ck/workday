import {execFile} from 'node:child_process';
import path from 'node:path';
import {z} from 'zod';
import {DateTime} from 'luxon';
import type {MeetingsQuery,MeetingsResult} from '../shared/types';
import {schemas} from './schemas';
import {date,parse} from './validation';

const LIMIT=512*1024;
const status=z.enum(['ready','notDetermined','denied','restricted','notFound','ambiguous','unsupported','error']);
const instant=z.string().max(40).refine(v=>/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&DateTime.fromISO(v).isValid);
const meeting=z.object({id:z.string().min(1).max(1024),title:z.string().max(1000),start:instant,end:instant,allDay:z.boolean(),startDate:date.nullable(),endDate:date.nullable()}).strict().refine(v=>Date.parse(v.end)>Date.parse(v.start)&&(v.allDay?!!v.startDate&&!!v.endDate&&v.endDate>v.startDate:v.startDate===null&&v.endDate===null));
const response=z.object({status,meetings:z.array(meeting).max(2000)}).strict();
const messages:Record<MeetingsResult['status'],string|null>={ready:null,notDetermined:'连接电脑日历中的「我的日历（钉钉）」',denied:'请在系统设置的隐私与安全性 → 日历中允许 WorkDay 读取日历',restricted:'系统策略限制了日历访问',notFound:'电脑日历中未找到「我的日历（钉钉）」',ambiguous:'存在多个「我的日历（钉钉）」，请在系统日历中区分名称后重试',unsupported:'会议同步仅支持 macOS',error:'无法读取电脑日历，请重试'};
type Runner=(file:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<string>;
const run:Runner=(file,args,options)=>new Promise((resolve,reject)=>execFile(file,args,{...options,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)));
export class Meetings {
 constructor(private runner:Runner=run,private platform:string=process.platform){}
 async query(input:MeetingsQuery):Promise<MeetingsResult>{
  const p:MeetingsQuery=parse(schemas['meetings.query'],input);
  const range={startDate:p.startDate,endDate:p.endDate,timezone:p.timezone};
  const empty=(status:MeetingsResult['status']):MeetingsResult=>({...range,status,meetings:[],message:messages[status]});
  if(this.platform!=='darwin')return empty('unsupported');
  try{
   const raw=await this.runner(path.resolve(__dirname,'../../native/calendar-events'),[p.startDate,p.endDate,p.timezone,String(p.requestAccess===true)],{timeout:p.requestAccess?120000:20000,maxBuffer:LIMIT});
   if(Buffer.byteLength(raw)>LIMIT)return empty('error');
   const value=response.parse(JSON.parse(raw));
   if(value.status!=='ready')return empty(value.status);
   const unique=new Map(value.meetings.map(m=>[m.id+'\0'+m.start,m]));
   return {...range,status:'ready',message:null,meetings:[...unique.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.title.localeCompare(b.title))};
  }catch{return empty('error');}
 }
}
