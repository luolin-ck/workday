import {z} from 'zod';
import type {MessageMetrics,TokenUsage} from '../shared/types';

export const tokenFields=['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteTokens'] as const;
const counter=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenShape={inputTokens:counter.optional(),outputTokens:counter.optional(),totalTokens:counter.optional(),cachedInputTokens:counter.optional(),cacheWriteTokens:counter.optional()};
export const messageMetricsSchema=z.object({
 startedAt:z.string().datetime({offset:true}),completedAt:z.string().datetime({offset:true}).optional(),durationMs:counter.optional(),interrupted:z.boolean().optional(),
 rounds:counter.max(17),completedRounds:counter.max(17),usage:z.object(tokenShape).strict().optional(),reportedRounds:z.object(tokenShape).strict().optional(),
}).strict().superRefine((m,ctx)=>{
 const invalid=()=>ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid message metric coverage'});
 if(m.completedRounds>m.rounds||m.interrupted&&(m.completedAt!==undefined||m.durationMs!==undefined)||m.durationMs!==undefined&&m.completedAt===undefined)invalid();
 for(const key of tokenFields){const value=m.usage?.[key],count=m.reportedRounds?.[key];if(value===undefined?count!==undefined:count===undefined||count<1||count>m.rounds)invalid();}
});

/** Usage fields are optional evidence, never an excuse to fail a valid answer. */
export function normalizeUsage(value:unknown):TokenUsage|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const u=value as Record<string,any>,detail=u.prompt_tokens_details;
 const fields={inputTokens:u.prompt_tokens,outputTokens:u.completion_tokens,totalTokens:u.total_tokens,cachedInputTokens:detail?.cached_tokens,cacheWriteTokens:detail?.cache_write_tokens};
 const result:TokenUsage={};
 for(const key of tokenFields)if(typeof fields[key]==='number'&&Number.isSafeInteger(fields[key])&&fields[key]>=0)result[key]=fields[key];
 if(result.inputTokens!==undefined&&result.cachedInputTokens!==undefined&&result.cachedInputTokens>result.inputTokens)delete result.cachedInputTokens;
 return Object.keys(result).length?result:undefined;
}

/** One meter is created per assistant attempt. Its monotonic origin never crosses a process boundary. */
export class MessageMeter {
 private readonly startedAt=new Date().toISOString();
 private readonly origin=performance.now();
 private completedAt?:string;
 private durationMs?:number;
 private readonly rounds:{usage?:TokenUsage;complete:boolean}[]=[];
 beginRound(){this.rounds.push({complete:false});}
 observe(usage:TokenUsage){const round=this.rounds.at(-1);if(round)round.usage={...usage};}
 completeRound(){const round=this.rounds.at(-1);if(round)round.complete=true;}
 finish(){if(this.completedAt)return;const elapsed=performance.now()-this.origin;this.completedAt=new Date().toISOString();if(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=Number.MAX_SAFE_INTEGER)this.durationMs=Math.round(elapsed);}
 snapshot():MessageMetrics{
  const usage:TokenUsage={},reportedRounds:Partial<Record<keyof TokenUsage,number>>={};
  for(const key of tokenFields){let sum=0,count=0;for(const round of this.rounds){const value=round.usage?.[key];if(value!==undefined){sum+=value;count++;}}if(count&&Number.isSafeInteger(sum)){usage[key]=sum;reportedRounds[key]=count;}}
  return{startedAt:this.startedAt,...(this.completedAt?{completedAt:this.completedAt}:{}),...(this.durationMs===undefined?{}:{durationMs:this.durationMs}),rounds:this.rounds.length,completedRounds:this.rounds.filter(r=>r.complete).length,...(Object.keys(usage).length?{usage,reportedRounds}:{})};
 }
}

export function interruptedMetrics(metrics:MessageMetrics|undefined):MessageMetrics|undefined{
 if(!metrics)return;
 const {completedAt:_end,durationMs:_elapsed,...known}=metrics;
 return{...known,interrupted:true};
}
