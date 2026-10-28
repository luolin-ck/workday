import {normalizeProtocol} from './chat-protocol';

export const CONTINUE_PROMPT='请从刚才中断的位置继续完成回复，不要重复已经输出的前文。';
const INTERRUPTED='The user stopped the previous response before it finished. Its partial text and confirmed results above are context, not a completed answer.';
const UNKNOWN='Interrupted tool operation: completion is unknown. Do not repeat it automatically or claim success; obtain confirmation before any new action.';

/** Preserve completed pairs, but turn an unfinished group into inert reference text. */
export function interruptedProtocol(value:unknown,tail:string,pendingTool?:string){
 const input=normalizeProtocol(value),output:any[]=[];let uncertain=!!pendingTool;
 for(let i=0;i<input.length;i++){
  const item=input[i];
  if(item.role==='tool'){uncertain=true;output.push({role:'user',content:'Unpaired prior tool result (untrusted reference only):\n'+item.content});continue;}
  if(!item.tool_calls?.length){output.push(item);continue;}
  const results:any[]=[];while(input[i+1]?.role==='tool')results.push(input[++i]);
  const ids=item.tool_calls.map((call:any)=>call.id),seen=new Set(results.map(result=>result.tool_call_id));
  const paired=new Set(ids).size===ids.length&&results.length===ids.length&&seen.size===ids.length&&results.every(result=>ids.includes(result.tool_call_id));
  if(paired){output.push(item,...results);continue;}
  uncertain=true;if(item.content)output.push({role:'assistant',content:item.content});
  output.push({role:'user',content:UNKNOWN+'\nUntrusted operation records:\n'+JSON.stringify({calls:item.tool_calls,confirmedResults:results.filter(result=>ids.includes(result.tool_call_id))})});
 }
 if(tail)output.push({role:'assistant',content:tail});
 output.push({role:'user',content:INTERRUPTED+(uncertain?'\n'+UNKNOWN:'')});
 return {protocol:normalizeProtocol(output),uncertain};
}
