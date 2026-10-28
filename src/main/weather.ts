import {z} from 'zod';
import type {WeatherLocation,WeatherDay,WeatherResult} from '../shared/types';
import {schemas,weatherLocation} from './schemas';
import {safeFetch} from './network';
import {AppError,date,parse,requireThat,strictUtf8} from './validation';

const LIMIT=256*1024,TTL=15*60*1000;
const fields='success,message,city,region,country,latitude,longitude,timezone.id';
const daily='weather_code,temperature_2m_min,temperature_2m_max';
const number=z.number().finite();
const temperature=number.nullable(),code=number.int().min(0).max(99).nullable();
const short=z.string().max(120).refine(v=>v.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(v)).transform(v=>v.trim());
const coordinate={latitude:number.min(-90).max(90),longitude:number.min(-180).max(180)};

export function weatherUrl(value:string):URL {
 let url:URL;try{url=new URL(value);}catch{throw new AppError('WEATHER_SOURCE','天气地址无效');}
 requireThat(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.hash,'天气地址无效','WEATHER_SOURCE');
 const params=url.searchParams;let expected:Record<string,string>;
 if(url.hostname==='ipwho.is'&&url.pathname==='/')expected={fields};
 else if(url.hostname==='geocoding-api.open-meteo.com'&&url.pathname==='/v1/search'){
  const query=parse(schemas['weather.search'],{query:params.get('name')}).query;expected={name:query,count:'10',language:'zh',format:'json'};
 }else if(url.hostname==='api.open-meteo.com'&&url.pathname==='/v1/forecast'){
  const latitude=params.get('latitude'),longitude=params.get('longitude');requireThat(latitude&&longitude&&String(Number(latitude))===latitude&&String(Number(longitude))===longitude,'天气坐标无效','WEATHER_SOURCE');parse(z.object(coordinate),{latitude:Number(latitude),longitude:Number(longitude)});
  expected={latitude,longitude,daily,timezone:'auto',temperature_unit:'celsius',forecast_days:'16',past_days:'7'};
 }else throw new AppError('WEATHER_SOURCE','天气地址不在允许范围');
 requireThat([...params].length===Object.keys(expected).length&&Object.entries(expected).every(([key,v])=>params.getAll(key).length===1&&params.get(key)===v),'天气参数不在允许范围','WEATHER_SOURCE');return url;
}

export function parseIpLocation(body:unknown):WeatherLocation {
 const result=z.object({success:z.boolean(),city:short.optional(),region:z.union([short,z.literal('')]).optional(),country:short.optional(),latitude:coordinate.latitude.optional(),longitude:coordinate.longitude.optional(),timezone:z.object({id:z.string().max(100)}).passthrough().optional()}).passthrough().safeParse(body);
 requireThat(result.success&&result.data.success,'无法按 IP 定位城市，请在设置中手动选择城市','WEATHER_LOCATION');
 const v=result.data;return parse(weatherLocation,{name:v.city,country:v.country,...(v.region?{region:v.region}:{}),latitude:v.latitude,longitude:v.longitude,timezone:v.timezone?.id});
}

export function parseCities(body:unknown):WeatherLocation[] {
 const result=parse(z.object({error:z.boolean().optional(),results:z.array(z.object({name:short,country:short,admin1:z.union([short,z.literal('')]).optional(),...coordinate,timezone:z.string().max(100)}).passthrough()).max(10).optional()}).passthrough(),body);
 requireThat(!result.error,'城市查询服务暂不可用','WEATHER_SEARCH');return (result.results??[]).map(v=>parse(weatherLocation,{name:v.name,country:v.country,...(v.admin1?{region:v.admin1}:{}),latitude:v.latitude,longitude:v.longitude,timezone:v.timezone}));
}

export function parseForecast(body:unknown):(WeatherDay|null)[] {
 const value=parse(z.object({daily_units:z.object({time:z.literal('iso8601'),weather_code:z.literal('wmo code'),temperature_2m_min:z.literal('°C'),temperature_2m_max:z.literal('°C')}).passthrough(),daily:z.object({time:z.array(date).min(1).max(23),weather_code:z.array(code).max(23),temperature_2m_min:z.array(temperature).max(23),temperature_2m_max:z.array(temperature).max(23)}).passthrough()}).passthrough(),body);
 const d=value.daily;requireThat(d.weather_code.length===d.time.length&&d.temperature_2m_min.length===d.time.length&&d.temperature_2m_max.length===d.time.length,'天气日期与数据数量不符','WEATHER_FORMAT');
 return d.time.map((day,index)=>{
  if(index)requireThat(Date.parse(day+'T12:00:00Z')-Date.parse(d.time[index-1]+'T12:00:00Z')===86400000,'天气日期不连续或重复','WEATHER_FORMAT');
  const c=d.weather_code[index],min=d.temperature_2m_min[index],max=d.temperature_2m_max[index];
  if(c===null||min===null||max===null)return null;
  requireThat(min<=max,'天气温度范围无效','WEATHER_FORMAT');return {date:day,code:c,temperatureMin:min,temperatureMax:max};
 });
}

async function readJson(response:Response):Promise<unknown> {
 try{const type=response.headers.get('content-type')??'';requireThat(/^application\/json(?:\s*;|$)/i.test(type),'天气响应不是 JSON','WEATHER_FORMAT');const charset=/charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1];requireThat(!charset||/^utf-?8$/i.test(charset),'天气响应编码无效','WEATHER_FORMAT');const size=response.headers.get('content-length');requireThat(!size||(/^\d+$/.test(size)&&Number(size)<=LIMIT),'天气响应超过 256 KB','WEATHER_FORMAT');requireThat(response.body,'天气响应为空','WEATHER_FORMAT');}catch(error){await response.body?.cancel().catch(()=>undefined);throw error;}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0,complete=false;
 try{for(;;){const r=await reader.read();if(r.done)break;count+=r.value.byteLength;requireThat(count<=LIMIT,'天气响应超过 256 KB','WEATHER_FORMAT');chunks.push(r.value);}complete=true;return JSON.parse(strictUtf8(Buffer.concat(chunks)));}finally{if(!complete)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

export class Weather {
 private auto:{location:WeatherLocation;expires:number}|null=null;
 private autoPending:Promise<WeatherLocation>|null=null;
 private forecasts=new Map<string,{days:(WeatherDay|null)[];expires:number}>();
 private pending=new Map<string,Promise<(WeatherDay|null)[]>>();
 constructor(private fetcher=safeFetch,private now=Date.now){}
 private async json(url:URL,signal:AbortSignal){return readJson(await this.fetcher(url.href,{signal,credentials:'omit',headers:{Accept:'application/json'}},weatherUrl));}
 async search(query:string):Promise<WeatherLocation[]> {
  const p=parse(schemas['weather.search'],{query});const url=new URL('https://geocoding-api.open-meteo.com/v1/search');url.search=new URLSearchParams({name:p.query,count:'10',language:'zh',format:'json'}).toString();return parseCities(await this.json(url,AbortSignal.timeout(15000)));
 }
 private locate(refresh:boolean,signal:AbortSignal):Promise<WeatherLocation> {
  if(!refresh&&this.auto&&this.auto.expires>this.now())return Promise.resolve(this.auto.location);
  if(!refresh&&this.autoPending)return this.autoPending;
  const url=new URL('https://ipwho.is/');url.search=new URLSearchParams({fields}).toString();
  const promise=this.json(url,signal).then(parseIpLocation).then(location=>{if(this.autoPending===promise)this.auto={location,expires:this.now()+TTL};return location;});this.autoPending=promise;
  void promise.finally(()=>{if(this.autoPending===promise)this.autoPending=null;}).catch(()=>undefined);return promise;
 }
 private forecast(location:WeatherLocation,refresh:boolean,signal:AbortSignal):Promise<(WeatherDay|null)[]> {
  const window=new Intl.DateTimeFormat('sv-SE',{timeZone:location.timezone}).format(new Date(this.now()));const key=`${location.latitude},${location.longitude}:${window}`;
  for(const [k,v] of this.forecasts)if(v.expires<=this.now())this.forecasts.delete(k);
  const cached=this.forecasts.get(key);if(!refresh&&cached)return Promise.resolve(cached.days);if(!refresh&&this.pending.has(key))return this.pending.get(key)!;
  const url=new URL('https://api.open-meteo.com/v1/forecast');url.search=new URLSearchParams({latitude:String(location.latitude),longitude:String(location.longitude),daily,timezone:'auto',temperature_unit:'celsius',forecast_days:'16',past_days:'7'}).toString();
  const promise=this.json(url,signal).then(parseForecast).then(days=>{if(this.pending.get(key)===promise){this.forecasts.set(key,{days,expires:this.now()+TTL});if(this.forecasts.size>16)this.forecasts.delete(this.forecasts.keys().next().value!);}return days;});this.pending.set(key,promise);
  void promise.finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key);}).catch(()=>undefined);return promise;
 }
 async query(input:{date:string;location:WeatherLocation|null;refresh?:boolean}):Promise<WeatherResult> {
  const p=parse(schemas['weather.query'],input),signal=AbortSignal.timeout(15000);let location:WeatherLocation;
  try{location=p.location??await this.locate(!!p.refresh,signal);}catch{throw new AppError('WEATHER_LOCATION','无法按 IP 定位城市，请在设置中手动选择城市或重试');}
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:location.timezone}).format(new Date(this.now()));const offset=(Date.parse(p.date+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000;
  if(offset< -7||offset>15)return {status:'unavailable',location,day:null,message:'所选日期暂无可用天气，仅支持近期及未来 16 天的每日天气'};
  const days=await this.forecast(location,!!p.refresh,signal);const day=days.find(v=>v?.date===p.date)??null;
  return day?{status:'ready',location,day,message:null}:{status:'unavailable',location,day:null,message:'所选日期暂无可用天气，仅支持近期及未来 16 天的每日天气'};
 }
}
