import {contextBridge,ipcRenderer} from 'electron';
import type {WorkDayBridge} from '../shared/api';
// Capture native File objects in the isolated world. The page never receives a
// clipboard reader or a path-based file import capability.
let paste:{files:File[];expires:number;target:HTMLTextAreaElement}|undefined;
const denied=()=>({ok:false as const,error:{code:'PASTE',message:'请在消息输入框中重新粘贴附件。'}});
window.addEventListener('paste',(event:ClipboardEvent)=>{
 paste=undefined;
 const target=event.target;
 if(!event.isTrusted||!(target instanceof HTMLTextAreaElement)||target!==document.activeElement||!target.matches('[data-composer-paste]')||target.disabled||target.readOnly)return;
 const files=Array.from(event.clipboardData?.files??[]);
 if(files.length)paste={files,expires:Date.now()+1000,target};
},true);
const bridge:WorkDayBridge={
 async pasteAttachments(owner){
  const current=paste;paste=undefined;
  if(!current||current.expires<Date.now()||current.target!==document.activeElement)return denied();
  // Keep this tiny preload dependency-free: sandboxed Electron cannot require
  // application modules. Mirror the validated main-process input limits here.
  if(current.files.length>6)return {ok:false,error:{code:'LIMIT',message:'每条消息最多 6 个附件，请先移除部分附件。'}};
  if(current.files.some(file=>file.size>10*1024*1024))return {ok:false,error:{code:'LIMIT',message:'附件最多 10 MiB，请缩小后重试。'}};
  if(current.files.reduce((n,file)=>n+file.size,0)>24*1024*1024)return {ok:false,error:{code:'LIMIT',message:'一次粘贴的附件总大小最多 24 MiB。'}};
  try{
   const files=[];
   for(const file of current.files){const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length!==file.size)return denied();files.push({name:file.name||'粘贴图片.png',bytes});}
   return await ipcRenderer.invoke('workday:paste',owner,files);
  }catch{return {ok:false,error:{code:'FILE',message:'无法读取粘贴的附件，请重新复制后重试。'}};}
 },
 call:(operation,payload)=>ipcRenderer.invoke('workday:call',operation,payload),
 subscribe(listener){const callback=(_event:unknown,payload:any)=>listener(payload);ipcRenderer.on('workday:event',callback);return ()=>ipcRenderer.removeListener('workday:event',callback);}
};
contextBridge.exposeInMainWorld('workday',bridge);
