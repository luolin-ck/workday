import { useCallback, useEffect, useRef, useState } from 'react';
import { meetingRange } from '../shared/dates';
import type { MeetingsResult } from '../shared/types';
import type { Call } from './ui';

export function useMeetings(month:string, enabled:boolean, call:Call) {
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range=meetingRange(month,timezone),key=`${range.startDate}/${range.endDate}/${timezone}`;
  const current=useRef({range,key,enabled,call});
  current.current={range,key,enabled,call};
  const sequence=useRef(0);
  const accessPending=useRef(false);
  const [result,setResult]=useState<MeetingsResult|null>(null);
  const [loading,setLoading]=useState(false);
  const refresh=useCallback(async(requestAccess=false)=>{
    const request=current.current;
    if(!request.enabled||accessPending.current)return;
    if(requestAccess)accessPending.current=true;
    const id=++sequence.current;
    setResult(null);setLoading(true);
    try {
      const value=await request.call('meetings.query',{...request.range,...(requestAccess?{requestAccess:true}:{})});
      if(value.startDate!==request.range.startDate||value.endDate!==request.range.endDate||value.timezone!==request.range.timezone)throw new Error('日历返回的日期范围不一致，请重试。');
      if(id===sequence.current&&current.current.enabled&&current.current.key===request.key)setResult(value);
    } catch {
      if(id===sequence.current&&current.current.enabled&&current.current.key===request.key)setResult({...request.range,status:'error',meetings:[],message:'会议同步失败，请重试。'});
    } finally {
      if(id===sequence.current)setLoading(false);
      if(requestAccess){
        accessPending.current=false;
        // A system permission prompt may move focus or outlive a month change.
        if(current.current.enabled&&(id!==sequence.current||current.current.key!==request.key))void refresh();
      }
    }
  },[]);
  useEffect(()=>{
    setResult(null);
    if(enabled)void refresh();else setLoading(false);
    return()=>{sequence.current++;};
  },[key,enabled,refresh]);
  useEffect(()=>{
    if(!enabled)return;
    const resume=()=>{if(document.visibilityState==='visible')void refresh();};
    window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
    return()=>{window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
  },[enabled,refresh]);
  const visible=enabled&&result?.startDate===range.startDate&&result.endDate===range.endDate&&result.timezone===timezone?result:null;
  return {result:visible,loading,refresh};
}
