import {ActionIcon} from '@mantine/core';
import {useEffect,useRef,useState,type ClipboardEvent} from 'react';
import {CHAT_LIMITS,type AttachmentRef,type ContextOwner} from '../shared/chat-context';
import type {ContextSelection} from '../shared/types';
import {Icon} from './icons';
import {Hint,useApp} from './ui';

export function pastedMessageText(text:string,names:string[]){
 const trimmed=text.trim(),lines=trimmed.split(/\r?\n/);
 // Finder may provide file labels or file URLs alongside the actual File list.
 if(trimmed&&(lines.every(line=>/^file:\/\//i.test(line))||trimmed===names.join('\n')||trimmed===names.join('\r\n')))return '';
 return text;
}
export function useComposerAttachments({owner,scope,value,onChange,onBusyChange,disabled}:{owner:ContextOwner;scope:string;value:ContextSelection;onChange:(value:ContextSelection)=>void;onBusyChange:(busy:boolean)=>void;disabled:boolean}){
 const {call}=useApp();
 const [error,setError]=useState(''),[previews,setPreviews]=useState<Record<string,string>>({}),[preparing,setPreparing]=useState(false);
 const runtime=useRef({scope,revision:0,alive:true,owner,value,onChange,onBusyChange,disabled,call});
 if(runtime.current.scope!==scope)runtime.current.revision++;
 Object.assign(runtime.current,{scope,owner,value,onChange,onBusyChange,disabled,call});
 const job=useRef<{id:symbol;revision:number}|null>(null);
 useEffect(()=>{runtime.current.alive=true;return()=>{runtime.current.alive=false;runtime.current.onBusyChange(false);};},[]);
 useEffect(()=>{setError('');setPreviews({});if(job.current&&job.current.revision!==runtime.current.revision){job.current=null;setPreparing(false);onBusyChange(false);}},[scope]);
 const tokens=(value.attachmentRefs??[]).map(a=>a.token).join(',');
 useEffect(()=>{
  let active=true;const revision=runtime.current.revision;
  setPreviews(old=>Object.fromEntries(Object.entries(old).filter(([token])=>tokens.split(',').includes(token))));
  if(tokens)void runtime.current.call('context.attachments.preview',{owner,tokens:tokens.split(',')}).then(result=>{if(active&&runtime.current.revision===revision)setPreviews(result);}).catch(e=>{if(active&&runtime.current.revision===revision)setError(e.message);});
  return()=>{active=false;};
 },[scope,tokens]);
 function begin(){const r=runtime.current;if(!r.alive||r.disabled||job.current?.revision===r.revision)return null;const current={id:Symbol(),revision:r.revision};job.current=current;setError('');setPreparing(true);r.onBusyChange(true);return {...current,owner:{...r.owner},call:r.call};}
 function valid(current:{revision:number}){return runtime.current.alive&&runtime.current.revision===current.revision;}
 function finish(current:{id:symbol}){if(job.current?.id===current.id){job.current=null;if(runtime.current.alive){setPreparing(false);runtime.current.onBusyChange(false);}}}
 async function upload(paste=false){
  const current=begin();if(!current)return;
  try{
   const picked=paste?await window.workday.pasteAttachments(current.owner).then(result=>{if(!result.ok)throw Error(result.error.message);return result.value;}):await current.call('context.attachments.pick',{owner:current.owner});
   if(!valid(current)){if(picked.length)await current.call('context.attachments.remove',{owner:current.owner,tokens:picked.map(a=>a.token)});return;}
   const latest=runtime.current;
   if((latest.value.attachmentRefs?.length??0)+picked.length>CHAT_LIMITS.attachments){await current.call('context.attachments.remove',{owner:current.owner,tokens:picked.map(a=>a.token)});throw Error('每条消息最多 6 个附件，请先移除部分附件。');}
   latest.onChange({...latest.value,attachmentRefs:[...(latest.value.attachmentRefs??[]),...picked]});
  }catch(e){if(valid(current))setError(e instanceof Error?e.message:'无法准备附件，请重试。');}
  finally{finish(current);}
 }
 async function remove(token:string){const current=begin();if(!current)return;try{await current.call('context.attachments.remove',{owner:current.owner,tokens:[token]});if(valid(current)){const latest=runtime.current;latest.onChange({...latest.value,attachmentRefs:latest.value.attachmentRefs?.filter(a=>a.token!==token)});}}catch(e){if(valid(current))setError(e instanceof Error?e.message:'无法移除附件。');}finally{finish(current);}}
 function paste(event:ClipboardEvent<HTMLTextAreaElement>,onText:(text:string,start:number,end:number)=>void){
  const files=Array.from(event.clipboardData.files);if(!files.length)return;
  event.preventDefault();
  const text=pastedMessageText(event.clipboardData.getData('text/plain'),files.map(f=>f.name));
  if(text)onText(text,event.currentTarget.selectionStart,event.currentTarget.selectionEnd);
  if(runtime.current.disabled||job.current?.revision===runtime.current.revision)return;
  void upload(true);
 }
 return {paste,upload:()=>void upload(),remove:(token:string)=>void remove(token),preparing,error,previews};
}
function sizeLabel(size:number){return size<1024?`${size} B`:size<1024*1024?`${Math.ceil(size/1024)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
export function ComposerAttachments({attachments,previews,preparing,error,disabled,onRemove}:{attachments:AttachmentRef[];previews:Record<string,string>;preparing:boolean;error:string;disabled:boolean;onRemove:(token:string)=>void}){
 if(!attachments.length&&!preparing&&!error)return null;
 return <div className="composer-attachment-area">
 {attachments.length>0&&<div className="composer-attachments" aria-label="已添加附件">{attachments.map(a=>{
  const image=a.mime==='image/png'||a.mime==='image/jpeg',preview=previews[a.token];
  return <div className={`composer-attachment ${image?'composer-attachment-image':'composer-attachment-file'}`} key={a.token}>
   <Hint label={`${a.name} · ${sizeLabel(a.size)}`}><div className="composer-attachment-content">{image?(preview&&/^data:image\/(?:png|jpeg);base64,/.test(preview)?<img src={preview} alt={a.name}/>:<Icon name="paperclip"/>):<><Icon name="paperclip"/><span><strong>{a.name}</strong><small>{a.mime==='application/pdf'?'PDF':'文本'} · {sizeLabel(a.size)}</small></span></>}</div></Hint>
   <ActionIcon className="composer-attachment-remove" variant="default" type="button" size="var(--size-actionSmall)" aria-label={`移除附件 ${a.name}`} disabled={disabled||preparing} onClick={()=>onRemove(a.token)}><Icon name="x" size="xs"/></ActionIcon>
  </div>;
 })}</div>}
 {preparing&&<span className="composer-attachment-status" role="status"><Icon name="loader-circle" size="sm"/>正在准备附件…</span>}
 {error&&<span className="composer-attachment-error" role="alert">{error}</span>}
 </div>;
}
