import {describe,it,expect} from 'vitest';
import * as content from '../src/renderer/ChatMessageContent';

const message=(extra:Record<string,unknown>={})=>({id:'fixture',conversationId:'chat',requestId:'request',role:'assistant',content:'Fixture',status:'complete',createdAt:'2026-10-27T00:00:00Z',...extra});
const metrics=(extra:Record<string,unknown>={})=>({startedAt:'2026-10-27T00:00:00Z',completedAt:'2026-10-27T00:02:29Z',durationMs:149000,rounds:1,completedRounds:1,usage:{inputTokens:222031,outputTokens:10866,totalTokens:232897,cachedInputTokens:222025,cacheWriteTokens:81536},reportedRounds:{inputTokens:1,outputTokens:1,totalTokens:1,cachedInputTokens:1,cacheWriteTokens:1},...extra});
function rows(value:ReturnType<typeof message>){
 const build=(content as any).messageDetailRows;
 expect(build,'message details must expose a shared metrics view for hover and click').toBeTypeOf('function');
 return build(value,'Fixture Model') as {label:string;value:string;note?:string}[];
}
const row=(data:ReturnType<typeof rows>,label:string)=>data.find(item=>item.label===label);
describe('message metrics presentation',()=>{
 it('shows reported counts once, actual duration and complete time',()=>{
  const values=rows(message({metrics:metrics()}));
  expect(row(values,'状态')?.value).toBe('成功');expect(row(values,'耗时')?.value).toBe('2 分 29 秒');
  expect(row(values,'完成时间')?.value).not.toBe('未记录');
  expect(row(values,'总 Token')?.value).toBe('232,897');
  expect(row(values,'输入')?.value).toBe('222,031');expect(row(values,'输出')?.value).toBe('10,866');
  expect(row(values,'缓存命中')?.value).toBe('222,025');expect(row(values,'缓存写入')?.value).toBe('81,536');
  expect(values.some(item=>/费用|Cost/.test(item.label))).toBe(false);
 });
 it('distinguishes old records, missing provider usage and reported zero',()=>{
  const old=rows(message());expect(row(old,'耗时')?.value).toBe('未记录');expect(row(old,'完成时间')?.value).toBe('未记录');expect(row(old,'总 Token')?.value).toBe('未记录');
  const absent=rows(message({metrics:metrics({usage:undefined,reportedRounds:undefined})}));expect(row(absent,'总 Token')?.value).toBe('未提供');expect(row(absent,'缓存命中')).toBeUndefined();
  const zero=rows(message({metrics:metrics({durationMs:0,usage:{inputTokens:0,outputTokens:0,totalTokens:0},reportedRounds:{inputTokens:1,outputTokens:1,totalTokens:1}})}));expect(row(zero,'总 Token')?.value).toBe('0');expect(row(zero,'耗时')?.value).toBe('0 秒');
 });
 it('marks coverage independently and incomplete stream counts as partial',()=>{
  const values=rows(message({metrics:metrics({rounds:2,completedRounds:2,reportedRounds:{inputTokens:2,outputTokens:1,totalTokens:1,cachedInputTokens:2}})}));
  expect(row(values,'输入')?.note).toBeUndefined();expect(row(values,'输出')?.note).toBe('部分统计');expect(row(values,'总 Token')?.note).toBe('部分统计');
  const failed=rows(message({status:'failed',metrics:metrics({completedRounds:0})}));expect(row(failed,'输入')?.note).toBe('部分统计');
 });
 it('does not invent duration or completion after interruption; running is explicit',()=>{
  const values=rows(message({status:'failed',metrics:metrics({completedAt:undefined,durationMs:undefined,interrupted:true})}));
  expect(row(values,'状态')?.value).toBe('已中断');expect(row(values,'耗时')?.value).toBe('未记录');expect(row(values,'完成时间')?.value).toBe('未记录');expect(row(values,'输入')?.note).toBe('部分统计');
  const running=rows(message({status:'running',metrics:metrics({completedAt:undefined,durationMs:undefined})}));expect(row(running,'状态')?.value).toBe('生成中');expect(row(running,'耗时')?.value).toBe('计时中');expect(row(running,'输入')?.note).toBe('统计中');
  const starting=rows(message({status:'running'}));expect(row(starting,'总 Token')?.value).toBe('统计中');
 });
 it('shows subsecond and hour durations and omits telemetry on non-assistant messages',()=>{
  expect(row(rows(message({metrics:metrics({durationMs:375})})),'耗时')?.value).toBe('0.375 秒');
  expect(row(rows(message({metrics:metrics({durationMs:3661000})})),'耗时')?.value).toBe('1 小时 1 分 1 秒');
  for(const role of ['user','tool']){const values=rows(message({role,metrics:metrics()}));expect(row(values,'总 Token')).toBeUndefined();expect(row(values,'耗时')).toBeUndefined();expect(row(values,'时间')).toBeDefined();}
 });
});
