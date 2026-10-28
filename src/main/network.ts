import {requireThat,remoteUrl,AppError} from './validation';
import type {TokenUsage} from '../shared/types';
import {normalizeUsage} from './message-metrics';
async function transportFetch(url:string,init:RequestInit,validate:(url:string)=>URL){validate(url);const options:RequestInit={...init,redirect:'error',credentials:'omit'};return await(process.versions.electron?require('electron').net.fetch(url,options):fetch(url,options)) as Response;}
export async function safeFetch(url:string,init:RequestInit={},validate:((url:string)=>URL)=remoteUrl){const response=await transportFetch(url,init,validate);if(!response.ok)throw new AppError('REMOTE',`远端返回 HTTP ${response.status}`);return response;}

async function rejectsUsageOption(response:Response){
 if(![400,422].includes(response.status)||!response.body)return false;
 const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder();
 try{
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)return false;text+=decoder.decode(part.value,{stream:true});}
  text+=decoder.decode();const error=JSON.parse(text)?.error;if(!error||typeof error!=='object'||Array.isArray(error))return false;
  const parameter=typeof error.param==='string'?error.param:null;
  if(parameter&&!['stream_options','stream_options.include_usage','include_usage'].includes(parameter))return false;
  const unsupported=['unsupported_parameter','unknown_parameter','unrecognized_parameter'].includes(error.code);
  const message=typeof error.message==='string'?error.message:'';
  const namesOption=/\b(?:stream_options|include_usage)\b/.test(message);
  const namesRejection=/\b(?:unsupported|not supported|unknown|unrecognized|unrecognised|not permitted)\b/i.test(message);
  return !!parameter&&(unsupported||namesRejection)||!parameter&&namesOption&&namesRejection;
 }catch{return false;}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}

/** Only a rejected usage option can cause one pre-stream compatibility resend. */
export async function fetchCompletion(url:string,init:RequestInit,validate:((url:string)=>URL)=remoteUrl){
 init.signal?.throwIfAborted();const body=JSON.parse(init.body as string);
 const response=await transportFetch(url,{...init,body:JSON.stringify({...body,stream_options:{include_usage:true}})},validate);
 if(response.ok)return response;
 const retry=await rejectsUsageOption(response);init.signal?.throwIfAborted();
 if(!retry)throw new AppError('REMOTE',`远端返回 HTTP ${response.status}`);
 return safeFetch(url,init,validate);
}
export interface StreamRound {content:string;calls:{id:string;name:string;arguments:string}[];usage?:TokenUsage}
export async function readCompletion(response:Response,onDelta:(text:string)=>void|Promise<void>,onUsage?:(usage:TokenUsage)=>void|Promise<void>):Promise<StreamRound>{
 requireThat(response.body,'响应没有流');const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',content='',done=false,finished=false,successful=false,usage:TokenUsage|undefined;const calls=new Map<number,{id:string;name:string;arguments:string}>();
 async function frame(frame:string){requireThat(frame.length<=1000000,'流事件过大');const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)return;if(data==='[DONE]'){done=true;return;}let item:any;try{item=JSON.parse(data);}catch{throw new AppError('REMOTE','流事件 JSON 无效');}requireThat(item&&typeof item==='object'&&!Array.isArray(item),'流事件格式无效','REMOTE');requireThat(!item.error,'远端流返回错误','REMOTE');const observed=normalizeUsage(item.usage);if(observed&&JSON.stringify(observed)!==JSON.stringify(usage)){usage=observed;await onUsage?.(observed);}const choice=item.choices?.[0];if(!choice)return;const delta=choice.delta;if(typeof delta?.content==='string'){content+=delta.content;requireThat(content.length<=200000,'回复过长');await onDelta(delta.content);}for(const t of delta?.tool_calls??[]){const v=calls.get(t.index)??{id:'',name:'',arguments:''};v.id+=t.id??'';v.name+=t.function?.name??'';v.arguments+=t.function?.arguments??'';requireThat(v.arguments.length<=30000,'工具参数过长');calls.set(t.index,v);requireThat(calls.size<=4,'每轮工具调用最多 4 次');}if(choice.finish_reason!==null&&choice.finish_reason!==undefined){requireThat(choice.finish_reason==='stop'||choice.finish_reason==='tool_calls','回复未完整生成，请调整请求后重试','REMOTE');finished=true;}}
 async function consume(){let separator:RegExpExecArray|null;while((separator=/\r?\n\r?\n/.exec(buffer))){await frame(buffer.slice(0,separator.index));buffer=buffer.slice(separator.index+separator[0].length);}const tail=buffer.replace(/(?:\r?\n\r?|\r)$/,'');requireThat(tail.length<=1000000,'流事件过大');}
 try {for(;;){const {value,done:ended}=await reader.read();if(ended)break;buffer+=decoder.decode(value,{stream:true});await consume();}buffer+=decoder.decode();await consume();if(buffer.trim())await frame(buffer);requireThat(done&&finished,'回复流提前结束，请重试','REMOTE');successful=true;return {content,calls:[...calls.values()],...(usage?{usage}:{})};}finally{if(!successful)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
