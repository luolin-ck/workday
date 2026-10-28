import {describe,it,expect,vi} from 'vitest';
import {readCompletion} from '../src/main/network';

const event=(item:unknown,end='\n\n')=>'data: '+JSON.stringify(item)+end;
const finish=event({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
function response(chunks:(string|Uint8Array)[]){
 const encoder=new TextEncoder(),cancel=vi.fn(async()=>{}),releaseLock=vi.fn();let index=0;
 const reader={read:async()=>index<chunks.length?{value:typeof chunks[index]==='string'?encoder.encode(chunks[index++] as string):chunks[index++] as Uint8Array,done:false}:{done:true},cancel,releaseLock};
 return {value:{body:{getReader:()=>reader}} as unknown as Response,cancel,releaseLock};
}

describe('completion SSE event boundaries',()=>{
 it('accepts 101 legal 10k events in one network chunk just as in separate chunks',async()=>{
  const frames=Array.from({length:101},()=>event({choices:[{delta:{content:'x'},finish_reason:null}],padding:'a'.repeat(10000)}));
  for(const chunks of [[frames.join('')+finish],[...frames,finish]]){
   const stream=response(chunks),onDelta=vi.fn();
   expect((await readCompletion(stream.value,onDelta)).content).toBe('x'.repeat(101));
   expect(onDelta).toHaveBeenCalledTimes(101);expect(stream.cancel).not.toHaveBeenCalled();expect(stream.releaseLock).toHaveBeenCalledOnce();
  }
 });
 it('handles UTF8, CRLF separators split across individual bytes, and EOF frame flush',async()=>{
  const raw=event({choices:[{delta:{content:'中文🙂'},finish_reason:null}]},'\r\n\r\n')+event({choices:[{delta:{},finish_reason:'stop'}]},'\r\n\r\n')+'data: [DONE]';
  const stream=response([...new TextEncoder().encode(raw)].map(b=>new Uint8Array([b])));let received='';
  expect(await readCompletion(stream.value,t=>{received+=t;})).toEqual({content:'中文🙂',calls:[]});expect(received).toBe('中文🙂');expect(stream.releaseLock).toHaveBeenCalledOnce();
 });
 it('allows a maximum-size event when a CRLF separator is split after its first byte',async()=>{
  const prefix='data: '+JSON.stringify({padding:''}),frame=prefix.slice(0,-2)+'a'.repeat(1000000-prefix.length)+prefix.slice(-2);
  expect(frame.length).toBe(1000000);
  expect(await readCompletion(response([frame+'\r','\n\r','\n'+finish]).value,()=>{})).toEqual({content:'',calls:[]});
 });
 it.each([
  ['oversized complete event',event({padding:'a'.repeat(1000000)})+finish,'流事件过大'],
  ['oversized unfinished tail','data: '+ 'a'.repeat(1000000),'流事件过大'],
  ['invalid JSON','data: {broken}\n\n'+finish,'JSON 无效'],
  ['remote error',event({error:{message:'PRIVATE'}}),'远端流返回错误'],
  ['missing DONE',event({choices:[{delta:{},finish_reason:'stop'}]}),'提前结束'],
  ['missing finish','data: [DONE]\n\n','提前结束'],
  ['truncated finish',event({choices:[{delta:{},finish_reason:'length'}]})+'data: [DONE]\n\n','未完整'],
  ['excess content',event({choices:[{delta:{content:'a'.repeat(200001)},finish_reason:'stop'}]})+'data: [DONE]\n\n','回复过长'],
  ['excess arguments',event({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'x',arguments:'a'.repeat(30001)}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n','工具参数过长'],
  ['excess tools',event({choices:[{delta:{tool_calls:Array.from({length:5},(_,index)=>({index,id:String(index),function:{name:'x',arguments:'{}'}}))},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n','最多 4 次'],
 ])('rejects %s and cancels/releases the reader',async(_name,raw,message)=>{
  const stream=response([raw]);await expect(readCompletion(stream.value,()=>{})).rejects.toThrow(message);expect(stream.cancel).toHaveBeenCalledOnce();expect(stream.releaseLock).toHaveBeenCalledOnce();
 });
 it('preserves tool arguments fragmented across events',async()=>{
  const raw=event({choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'lookup',arguments:'{"a":'}}]},finish_reason:null}]})+event({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  expect(await readCompletion(response([raw]).value,()=>{})).toEqual({content:'',calls:[{id:'call-1',name:'lookup',arguments:'{"a":1}'}]});
 });
});
