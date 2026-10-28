import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {HolidayMark,HolidayYear,HolidayResult} from '../shared/types';
import {safeFetch} from './network';
import {atomicWrite} from './store';
import {AppError,date,requireThat,strictUtf8} from './validation';

const VERSION=1, LIMIT=1024*1024;
const names=['元旦','春节','清明节','劳动节','端午节','中秋节','国庆节'];
const title=(year:number)=>`国务院办公厅关于${year}年部分节假日安排的通知`;
const validYear=z.number().int().min(2000).max(2100);
const markSchema=z.object({date,name:z.enum(['元旦','春节','清明节','劳动节','端午节','中秋节','国庆节','国庆节、中秋节']),kind:z.enum(['rest','work'])}).strict();
const cacheSchema=z.object({parserVersion:z.literal(VERSION),year:validYear,sourceUrl:z.string().max(1000),sourceTitle:z.string().max(100),queriedAt:z.string().datetime(),days:z.array(markSchema).min(7).max(100)}).strict();

export function officialUrl(value:string,kind:'query'|'notice'):URL {
 let u:URL;try{u=new URL(value);}catch{throw new AppError('HOLIDAY_SOURCE','官方通知地址无效');}
 requireThat(u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.hash,'官方通知地址无效','HOLIDAY_SOURCE');
 if(kind==='query')requireThat(u.hostname==='sousuo.www.gov.cn'&&u.pathname==='/search-gov/data','官方检索地址无效','HOLIDAY_SOURCE');
 else requireThat(u.hostname==='www.gov.cn'&&!u.search&&/^\/zhengce\/(?:zhengceku\/\d{6}|content\/\d{4}-\d{2}\/\d{2})\/content_\d+\.htm$/.test(u.pathname),'官方通知地址无效','HOLIDAY_SOURCE');
 return u;
}

function plain(html:string):string {
 const value=html.replace(/<[^>]*>/g,'').replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{
  const known:Record<string,string>={'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
  if(known[entity.toLowerCase()])return known[entity.toLowerCase()];
  const n=entity.toLowerCase().startsWith('&#x')?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));
  requireThat(Number.isInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff),'通知字符无效','HOLIDAY_FORMAT');return String.fromCodePoint(n);
 });
 requireThat(!/&[a-z#][^;\s]*;/i.test(value),'通知格式暂不支持','HOLIDAY_FORMAT');return value.replace(/\s/g,'');
}

export function noticeFromSearch(body:unknown,year:number):string|null {
 validYear.parse(year);const b=z.object({code:z.number(),msg:z.string(),data:z.unknown(),searchVO:z.unknown()}).passthrough().safeParse(body);
 requireThat(b.success,'官方检索响应格式无效','HOLIDAY_QUERY');const v=b.data;
 if(v.code===1001){requireThat(v.msg==='抱歉，没有找到相关结果'&&Array.isArray(v.data)&&v.data.length===0&&v.searchVO===null,'官方检索响应异常','HOLIDAY_QUERY');return null;}
 requireThat(v.code===200,'官方检索响应异常','HOLIDAY_QUERY');
 const list=z.object({listVO:z.array(z.object({title:z.string().max(1000),puborg:z.string().max(200),url:z.string().max(1000)}).passthrough()).max(10)}).passthrough().safeParse(v.searchVO);
 requireThat(list.success,'官方检索结果格式无效','HOLIDAY_QUERY');const found=new Set<string>();
 for(const row of list.data.listVO){if(plain(row.title)!==title(year))continue;requireThat(plain(row.puborg)==='国务院办公厅','通知发布单位不符','HOLIDAY_SOURCE');found.add(officialUrl(row.url,'notice').href);}
 requireThat(found.size<=1,'查询到多份年度通知，请稍后重试','HOLIDAY_QUERY');return [...found][0]??null;
}

function contentBlock(html:string):string {
 const opening=/<div\b[^>]*\bid\s*=\s*["']UCAP-CONTENT["'][^>]*>/gi;const first=opening.exec(html);
 requireThat(first&&!opening.exec(html),'通知正文格式暂不支持','HOLIDAY_FORMAT');
 const tags=/<\/?div\b[^>]*>/gi;tags.lastIndex=first.index+first[0].length;let depth=1,match:RegExpExecArray|null;
 while((match=tags.exec(html))){depth+=/^<\/div/i.test(match[0])?-1:1;if(!depth)return html.slice(first.index+first[0].length,match.index);}
 throw new AppError('HOLIDAY_FORMAT','通知正文不完整');
}

function isoDay(year:number,month:number,day:number):string {
 const value=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 requireThat(date.safeParse(value).success,'通知日期无效','HOLIDAY_FORMAT');return value;
}

// shortcut: 仅解析已核验的2025/2026年度通知措辞；官网改变格式时整年拒绝，补充fixture后再扩展。
export function parseHolidayNotice(html:string,year:number):HolidayMark[] {
 validYear.parse(year);requireThat(Buffer.byteLength(html)<=LIMIT,'通知过大','HOLIDAY_FORMAT');const block=contentBlock(html);
 requireThat(!/<(?:script|style|iframe)\b/i.test(block),'通知正文格式暂不支持','HOLIDAY_FORMAT');
 const paragraphs=[...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(m=>plain(m[1]));
 requireThat((paragraphs[0]+paragraphs[1])===title(year)&&paragraphs.includes('国务院办公厅'),'通知年份或发布单位不符','HOLIDAY_FORMAT');
 requireThat(!plain(block.replace(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi,'')),'通知包含未识别的正文','HOLIDAY_FORMAT');
 const sections=paragraphs.filter(p=>/^[一二三四五六七八九十]、/.test(p));const covered=new Set<string>(),days=new Map<string,HolidayMark>();
 const intro=`现将${year}年元旦、春节、清明节、劳动节、端午节、中秋节和国庆节放假调休日期的具体安排通知如下。`;
 const closing='节假日期间，各地区、各部门要妥善安排好值班和安全、保卫、疫情防控等工作，遇有重大突发事件，要按规定及时报告并妥善处置，确保人民群众祥和平安度过节日假期。';
 const knownRemarks=new Set([`经国务院批准，${intro}`,`按照上述原则，${intro}`,
  closing,`鼓励单位和个人结合落实带薪年休假等制度，实际形成较长假期，推动错峰出行。${closing}`,
  ...(year===2025?['经党中央、国务院批准，根据2024年11月修订的《全国年节及纪念日放假办法》，自2025年1月1日起，全体公民放假的假日增加2天，其中春节、劳动节各增加1天。据此对放假调休原则作进一步优化完善，除个别特殊情形外，春节自农历除夕起放假调休8天，国庆节自10月1日起放假调休7天，劳动节放假调休5天，元旦、清明节、端午节、中秋节分别放假调休或连休3天（如逢周三则只在当日放假），国庆节放假如逢中秋节则合并放假8天。']:[])
 ]);
 const publisher=paragraphs.indexOf('国务院办公厅');requireThat(publisher===paragraphs.lastIndexOf('国务院办公厅'),'通知署名格式暂不支持','HOLIDAY_FORMAT');
 for(const [index,p] of paragraphs.entries()){
  if(index<2||sections.includes(p)||knownRemarks.has(p))continue;
  if(index===publisher+1){const signed=/^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(p);requireThat(signed,'通知署名日期无效','HOLIDAY_FORMAT');isoDay(Number(signed[1]),Number(signed[2]),Number(signed[3]));continue;}
  requireThat(!/[\d一二三四五六七八九十〇零]{1,4}[月日]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|放假|调休|上班|休息|休假|连休|假期|假日|安排/.test(p),'通知包含未识别的日期安排','HOLIDAY_FORMAT');
 }
 const add=(date:string,name:string,kind:'rest'|'work')=>{requireThat(!days.has(date),'通知包含重复或冲突日期','HOLIDAY_FORMAT');days.set(date,{date,name,kind});};
 for(const [index,section] of sections.entries()){
  const head=/^([一二三四五六七])、([^：]+)：(.+)$/.exec(section);requireThat(head&&head[1]==='一二三四五六七'[index],'通知章节格式暂不支持','HOLIDAY_FORMAT');const name=head[2];
  requireThat(names.includes(name)||name==='国庆节、中秋节','通知节日格式暂不支持','HOLIDAY_FORMAT');
  for(const part of name.split('、')){requireThat(!covered.has(part),'通知节日重复','HOLIDAY_FORMAT');covered.add(part);}
  const arrangement=head[3].replace(/（([^（）]*)）/g,(_,annotation:string)=>{requireThat(/^(?:周[一二三四五六日]|农历(?:除夕|正月初七|腊月二十八)、周[一二三四五六日])$/.test(annotation),'通知括号说明格式暂不支持','HOLIDAY_FORMAT');return '';});
  const rest=/^(\d{1,2})月(\d{1,2})日(?:至(?:(\d{1,2})月)?(\d{1,2})日)?放假(?:调休)?(?:，共(\d{1,2})天|(\d{1,2})天(?:，不调休)?)。([^]*)$/.exec(arrangement);
  requireThat(rest,'通知安排格式暂不支持','HOLIDAY_FORMAT');
  const start=isoDay(year,Number(rest[1]),Number(rest[2]));const end=isoDay(year,Number(rest[3]??rest[1]),Number(rest[4]??rest[2]));
  const count=(Date.parse(end+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000+1;
  requireThat(count>=1&&count<=16&&count===Number(rest[5]??rest[6]),'通知放假天数不符','HOLIDAY_FORMAT');
  for(let n=0;n<count;n++)add(new Date(Date.parse(start+'T12:00:00Z')+n*86400000).toISOString().slice(0,10),name,'rest');
  if(rest[7]){
   const work=/^((?:\d{1,2}月\d{1,2}日)(?:、\d{1,2}月\d{1,2}日)*)上班。$/.exec(rest[7]);requireThat(work,'通知调休格式暂不支持','HOLIDAY_FORMAT');
   for(const entry of work[1].split('、')){const m=/^(\d{1,2})月(\d{1,2})日$/.exec(entry)!;add(isoDay(year,Number(m[1]),Number(m[2])),name,'work');}
  }
 }
 requireThat(covered.size===names.length&&names.every(n=>covered.has(n)),'通知节日章节不完整','HOLIDAY_FORMAT');return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

async function boundedResponse(response:Response,type:'json'|'html'):Promise<string> {
 try{
  const mime=response.headers.get('content-type')??'';requireThat(type==='json'?/^application\/json(?:\s*;|$)/i.test(mime):/^text\/html(?:\s*;|$)/i.test(mime),'官方响应类型不符','HOLIDAY_QUERY');
  const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(mime)?.[1];requireThat(!charset||/^utf-?8$/i.test(charset),'官方响应编码暂不支持','HOLIDAY_QUERY');
  const size=response.headers.get('content-length');requireThat(!size||(/^\d+$/.test(size)&&Number(size)<=LIMIT),'官方响应过大','HOLIDAY_QUERY');requireThat(response.body,'官方响应为空','HOLIDAY_QUERY');
 }catch(error){await response.body?.cancel().catch(()=>undefined);throw error;}
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0,complete=false;
 try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;requireThat(length<=LIMIT,'官方响应过大','HOLIDAY_QUERY');chunks.push(r.value);}complete=true;return strictUtf8(Buffer.concat(chunks));}finally{if(!complete)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

export class Holidays {
 private pending=new Map<number,Promise<HolidayResult>>();
 constructor(private directory:string,private fetcher= safeFetch,private persist=atomicWrite){}
 private file(year:number){return path.join(this.directory,'holidays',`${year}.json`);}
 async cached(year:number):Promise<HolidayYear|null> {
  validYear.parse(year);
  try{
   const file=this.file(year),stat=await fs.stat(file);requireThat(stat.isFile()&&stat.size<=LIMIT,'节假日缓存无效');const bytes=await fs.readFile(file);const value=cacheSchema.parse(JSON.parse(strictUtf8(bytes)));
   requireThat(value.year===year&&value.sourceTitle===title(year),'节假日缓存年份无效');officialUrl(value.sourceUrl,'notice');
   const unique=new Set<string>();const covered=new Set<string>();
   for(const item of value.days){requireThat(item.date.startsWith(`${year}-`)&&!unique.has(item.date),'节假日缓存日期无效');unique.add(item.date);if(item.kind==='rest')for(const name of item.name.split('、'))covered.add(name);}
   requireThat(names.every(n=>covered.has(n)),'节假日缓存不完整');const {parserVersion,...data}=value;return data;
  }catch{return null;}
 }
 query(year:number,refresh=false):Promise<HolidayResult> {
  validYear.parse(year);const existing=this.pending.get(year);if(existing)return existing;
  const request=this.load(year,refresh);this.pending.set(year,request);void request.finally(()=>{if(this.pending.get(year)===request)this.pending.delete(year);}).catch(()=>undefined);return request;
 }
 private async load(year:number,refresh:boolean):Promise<HolidayResult> {
  const old=await this.cached(year);if(old&&!refresh)return {year,data:old,status:'cached',message:null};
  try{
   const signal=AbortSignal.timeout(15000);const query=new URL('https://sousuo.www.gov.cn/search-gov/data');
   query.search=new URLSearchParams({t:'zhengcelibrary_gw',q:`${year}年部分节假日安排的通知`,p:'1',n:'10',timetype:'timeqb',searchfield:'title'}).toString();
   const response=await this.fetcher(query.href,{signal,headers:{Accept:'application/json'},credentials:'omit'},v=>officialUrl(v,'query'));
   const sourceUrl=noticeFromSearch(JSON.parse(await boundedResponse(response,'json')),year);
   if(!sourceUrl)return {year,data:old,status:'not-found',message:'暂未查询到官方安排'};
   const notice=await this.fetcher(sourceUrl,{signal,headers:{Accept:'text/html'},credentials:'omit'},v=>officialUrl(v,'notice'));
   const days=parseHolidayNotice(await boundedResponse(notice,'html'),year);const data={year,sourceUrl,sourceTitle:title(year),queriedAt:new Date().toISOString(),days};
   try{await this.persist(this.file(year),JSON.stringify({parserVersion:VERSION,...data}));}catch{throw new AppError('HOLIDAY_CACHE','节假日缓存保存失败');}return {year,data,status:'updated',message:null};
  }catch(error){
   let message='节假日查询失败，请检查网络后重试';
   if(error instanceof AppError)message=error.message;else if((error as NodeJS.ErrnoException)?.code&&['EACCES','ENOSPC','EROFS','EIO'].includes((error as NodeJS.ErrnoException).code!))message='节假日缓存保存失败';
   else if(signalTimeout(error))message='节假日查询超时，请重试';
   return {year,data:old,status:'error',message};
  }
 }
 async source(year:number):Promise<string> {const data=await this.cached(year);requireThat(data,'该年暂无可打开的官方通知','NOT_FOUND');return officialUrl(data.sourceUrl,'notice').href;}
}
function signalTimeout(error:unknown){return error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError');}
