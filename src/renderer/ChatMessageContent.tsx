import {ActionIcon,Modal,Tooltip,UnstyledButton} from '@mantine/core';
import {Fragment,useEffect,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {Message,TokenUsage} from '../shared/types';
import {Icon} from './icons';
import {Hint,stamp,useApp} from './ui';

export function messageRole(message:Message){return message.role==='user'?'你':message.role==='tool'?(message.toolCalls?.length&&message.toolCalls.every(t=>t.kind==='project')?'项目查询':'MCP 工具'):'WorkDay AI';}

type DetailRow={label:string;value:string;note?:string;section?:boolean;secondary?:boolean;cache?:boolean};
const tokenValue=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function durationLabel(ms:number|undefined){
 if(!tokenValue(ms))return '未记录';
 if(ms<1000)return `${(ms/1000).toLocaleString('zh-CN',{maximumFractionDigits:3})} 秒`;
 const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
 return [hours?`${hours} 小时`:'',minutes?`${minutes} 分`:'',`${seconds%60} 秒`].filter(Boolean).join(' ');
}
export function messageDetailRows(message:Message,model:string):DetailRow[]{
 if(message.role!=='assistant')return [{label:'发送者',value:messageRole(message)},{label:'时间',value:stamp(message.createdAt)},...(model?[{label:'模型',value:model,secondary:true}]:[])];
 const metrics=message.metrics,running=message.status==='running';
 const rows:DetailRow[]=[
  {label:'状态',value:metrics?.interrupted?'已中断':({complete:'成功',failed:'失败',cancelled:'已停止',running:'生成中'})[message.status]},
  {label:'完成时间',value:metrics?.completedAt?stamp(metrics.completedAt):running?'尚未结束':'未记录'},
  {label:'耗时',value:running?'计时中':durationLabel(metrics?.durationMs)},
 ];
 const fields:{key:keyof TokenUsage;label:string;optional?:boolean;cache?:boolean;section?:boolean}[]=[
  {key:'totalTokens',label:'总 Token',section:true},{key:'inputTokens',label:'输入'},{key:'outputTokens',label:'输出'},
  {key:'cachedInputTokens',label:'缓存命中',optional:true,cache:true},{key:'cacheWriteTokens',label:'缓存写入',optional:true,cache:true},
 ];
 for(const field of fields){
  const value=metrics?.usage?.[field.key],reported=metrics?.reportedRounds?.[field.key];
  if(field.optional&&!tokenValue(value))continue;
  const partial=!!metrics&&(metrics.interrupted||!metrics.rounds||metrics.completedRounds<metrics.rounds||!tokenValue(reported)||reported<metrics.rounds);
  rows.push({label:field.label,value:tokenValue(value)?value.toLocaleString('en-US'):running?'统计中':!metrics?'未记录':'未提供',...(tokenValue(value)&&(running||partial)?{note:running?'统计中':'部分统计'}:{}),section:field.section,cache:field.cache});
 }
 if(model)rows.push({label:'模型',value:model,section:true,secondary:true});
 return rows;
}
function MessageDetails({message,model}:{message:Message;model:string}){
 return <dl className="message-metrics">{messageDetailRows(message,model).map(row=><Fragment key={row.label}>
  <dt className={row.section?'message-metrics-section':undefined}>{row.label}</dt>
  <dd className={[row.section?'message-metrics-section':'',row.secondary?'message-metrics-secondary':'',row.cache?'message-metrics-cache':''].filter(Boolean).join(' ')}><span>{row.value}</span>{row.note&&<small>{row.note}</small>}</dd>
 </Fragment>)}</dl>;
}

// Chat content is inert reading material. Links expose their address without navigation;
// Markdown images never load remote/local URLs and raw HTML is never rendered.
export function MessageBody({message}:{message:Message}){
 if(!message.content)return null;
 return message.role==='assistant'?<div className="message-content message-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
  a:({children,href})=><Hint label={href||'链接地址不可用'}><span className="message-markdown-link" tabIndex={0}>{children}</span></Hint>,
  img:({alt})=><span className="message-image-reference">[图片{alt?`：${alt}`:''}]</span>,
  table:({children})=><div className="message-table-scroll" tabIndex={0} role="region" aria-label="表格"><table>{children}</table></div>,
 }}>{message.content}</Markdown></div>:<div className="message-content">{message.content}</div>;
}

export type MessageRetryAction={onRetry:()=>void;label:string;disabledReason?:string};
export function MessageActions({message,model,retry}:{message:Message;model:string;retry?:MessageRetryAction}){
 const [copied,setCopied]=useState(''),[details,setDetails]=useState(false);
 useEffect(()=>{setCopied('');setDetails(false);},[message.id]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),2500);return()=>clearTimeout(timer);},[copied]);
 async function copy(){try{await navigator.clipboard.writeText(message.content);setCopied('已复制');}catch{setCopied('复制失败，请重试');}}
 return <div className="message-actions">
  {message.content&&<Hint label={copied==='已复制'?'已复制':'复制消息'}><ActionIcon type="button" variant="subtle" className="message-action" size="var(--size-messageAction)" aria-label="复制消息" onClick={()=>void copy()}><Icon name={copied==='已复制'?'check':'copy'} size="sm"/></ActionIcon></Hint>}
  {retry&&<Hint label={retry.disabledReason??retry.label}><span className="hint-target" tabIndex={retry.disabledReason?0:undefined} aria-label={retry.disabledReason}><ActionIcon type="button" variant="subtle" className="message-action" size="var(--size-messageAction)" aria-label={retry.label} disabled={!!retry.disabledReason} onClick={retry.onRetry}><Icon name="refresh-cw" size="sm"/></ActionIcon></span></Hint>}
  <Tooltip label={<MessageDetails message={message} model={model}/>} disabled={details} classNames={{tooltip:'message-info-popover'}} multiline maw="calc(100vw - var(--space-24))" events={{hover:true,focus:true,touch:false}}><ActionIcon type="button" variant="subtle" className="message-action" size="var(--size-messageAction)" aria-label="消息详情" onClick={()=>setDetails(true)}><Icon name="info" size="sm"/></ActionIcon></Tooltip>
  {copied&&<span className="message-copy-feedback" role="status">{copied}</span>}
  <Modal opened={details} onClose={()=>setDetails(false)} centered title="消息详情" size="var(--size-messageInfo)" classNames={{content:'message-info-dialog',header:'message-info-dialog-header',close:'message-info-dialog-close'}}><MessageDetails message={message} model={model}/></Modal>
 </div>;
}

type SentAttachment={name:string;mime:string;size:number};
const sizeLabel=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${Math.ceil(size/1024)} KB`:`${(size/1024/1024).toFixed(1)} MB`;
export function SentAttachments({message}:{message:Message}){
 const {call}=useApp();
 const attachments:SentAttachment[]=Array.isArray((message.snapshot as any)?.attachments)?(message.snapshot as any).attachments:[];
 const key=message.conversationId+':'+message.id+':'+JSON.stringify(attachments);
 const [loaded,setLoaded]=useState<{key:string;urls:Record<string,string>}>({key:'',urls:{}});
 const [broken,setBroken]=useState<Record<string,boolean>>({}),[zoom,setZoom]=useState<{name:string;url:string}|null>(null);
 useEffect(()=>{
  let active=true;setBroken({});setZoom(null);
  if(attachments.some(a=>a.mime==='image/png'||a.mime==='image/jpeg'))void call('messages.attachments.preview',{conversationId:message.conversationId,messageId:message.id}).then(urls=>{if(active)setLoaded({key,urls});}).catch(()=>{if(active)setLoaded({key,urls:{}});});
  return()=>{active=false;};
 },[key,call]);
 if(!attachments.length)return null;
 const urls=loaded.key===key?loaded.urls:{};
 return <div className="message-attachments" aria-label="消息附件">{attachments.map((attachment,index)=>{
  const image=attachment.mime==='image/png'||attachment.mime==='image/jpeg',url=urls[String(index)];
  const preview=image&&!broken[index]&&url&&/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(url);
  const type=attachment.mime==='application/pdf'?'PDF':image?attachment.mime==='image/png'?'PNG':'JPEG':'文本';
  const label=attachment.name+' · '+type+' · '+sizeLabel(attachment.size);
  return preview?<Hint key={index} label={label}><UnstyledButton type="button" className="sent-attachment-image" aria-label={`查看图片 ${attachment.name}`} onClick={()=>setZoom({name:attachment.name,url})}><img src={url} alt={attachment.name} onError={()=>setBroken(old=>({...old,[index]:true}))}/></UnstyledButton></Hint>:
   <Hint key={index} label={label+(image?' · 预览不可用':'')}><div tabIndex={0} className="sent-attachment-file"><Icon name="paperclip"/><span><strong>{attachment.name}</strong><small>{type} · {sizeLabel(attachment.size)}{image?' · '+(loaded.key===key?'预览不可用':'正在读取…'):''}</small></span></div></Hint>;
 })}<Modal opened={!!zoom} onClose={()=>setZoom(null)} centered size="lg" title={zoom?.name} classNames={{title:'message-image-title'}}>{zoom&&<img className="sent-attachment-zoom" src={zoom.url} alt={zoom.name}/>}</Modal></div>;
}
