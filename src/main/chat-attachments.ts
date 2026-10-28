import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {CHAT_LIMITS,type AttachmentMaterial} from '../shared/chat-context';
import {AppError,requireThat} from './validation';
function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new AppError('CANCELLED','附件读取已取消');}
const imageExtensions=new Map([['.png','png'],['.jpg','jpeg'],['.jpeg','jpeg'],['.webp','webp']]);
const textExtensions=new Set(('.txt .md .markdown .mdx .json .jsonl .yaml .yml .toml .ini .cfg .conf .csv .tsv .log .html .htm .xml .svg .css .scss .sass .less .js .jsx .mjs .cjs .ts .tsx .vue .svelte .py .pyi .rs .go .java .kt .kts .c .h .cc .cpp .cxx .hh .hpp .cs .swift .m .mm .rb .php .sh .bash .zsh .fish .sql .graphql .gql .r .R .lua .pl .ex .exs .erl .hrl .clj .cljs .edn .dart .scala .sc .proto .tex .bib .diff .patch .lock .gitignore .gitattributes .editorconfig').toLowerCase().split(' '));
function byteKind(bytes:Buffer){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpeg';if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'webp';if(bytes.subarray(0,5).toString('ascii')==='%PDF-')return 'pdf';return 'text';}
const nativeErrors:Record<string,[string,string]>={INVALID:['FILE','附件内容损坏或格式不匹配'],LIMIT:['LIMIT','附件超过页数、像素或提取内容限制，请缩小后重试'],ENCRYPTED:['FILE','加密 PDF 无法读取，请先导出未加密版本'],NO_TEXT:['FILE','PDF 没有可提取文字，请改用文本版本；暂不支持扫描件 OCR']};
async function normalize(bytes:Buffer,kind:string,signal?:AbortSignal):Promise<{mime:AttachmentMaterial['mime'];text?:string;dataUrl?:string}>{
 cancelled(signal);requireThat(process.platform==='darwin','附件转换目前仅支持 macOS','UNAVAILABLE');
 return new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(__dirname,'../../native/chat-attachments'),[],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
  let output='',outputBytes=0,failure:AppError|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=(error:AppError)=>{if(!failure)failure=error;child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),500);};
  const abort=()=>stop(new AppError('CANCELLED','附件读取已取消'));
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop(new AppError('UNAVAILABLE','附件转换超时，请缩小文件后重试')),20000);
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{failure??=new AppError('UNAVAILABLE','附件转换程序不可用，请重新构建应用');});
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{outputBytes+=Buffer.byteLength(chunk);if(outputBytes>6*1024*1024)stop(new AppError('LIMIT','附件转换结果过大，请缩小文件后重试'));else output+=chunk;});
  child.once('close',code=>{
   clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
   if(failure){reject(failure);return;}
   try{
    const result=JSON.parse(output);
    if(result?.ok===false&&typeof result.code==='string'&&nativeErrors[result.code]){const [errorCode,message]=nativeErrors[result.code];throw new AppError(errorCode,message);}
    requireThat(code===0&&result?.ok===true&&Object.keys(result).every(key=>['ok','mime','text','data'].includes(key)),'附件转换返回无效结果','UNAVAILABLE');
    if(kind==='pdf'){requireThat(result.mime==='application/pdf'&&typeof result.text==='string'&&result.text.trim().length>0&&result.text.length<=CHAT_LIMITS.attachmentText&&result.data===undefined,'PDF 提取结果无效','UNAVAILABLE');resolve({mime:result.mime,text:result.text});}
    else{requireThat((result.mime==='image/png'||result.mime==='image/jpeg')&&typeof result.data==='string'&&result.data.length<=Math.ceil(CHAT_LIMITS.imageBytes/3)*4&&result.text===undefined,'图片转换结果无效','UNAVAILABLE');const image=Buffer.from(result.data,'base64');requireThat(image.length>0&&image.length<=CHAT_LIMITS.imageBytes&&image.toString('base64')===result.data&&byteKind(image)===(result.mime==='image/png'?'png':'jpeg'),'图片转换结果无效','UNAVAILABLE');resolve({mime:result.mime,dataUrl:`data:${result.mime};base64,${result.data}`});}
   }catch(error){reject(error instanceof AppError?error:new AppError('UNAVAILABLE','附件转换返回无效结果'));}
  });
  child.stdin.end(JSON.stringify({kind:kind==='pdf'?'pdf':'image',data:bytes.toString('base64')}));
  if(signal?.aborted)abort();
 });
}
export async function readChatAttachment(filePath:string,signal?:AbortSignal):Promise<AttachmentMaterial>{
 cancelled(signal);requireThat(typeof filePath==='string'&&path.isAbsolute(filePath)&&!filePath.includes('\0'),'附件路径无效');
 let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
 try{
  handle=await fs.open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await handle.stat();requireThat(before.isFile(),'只能上传普通文件','FILE');requireThat(Number.isSafeInteger(before.size)&&before.size<=CHAT_LIMITS.fileBytes,'附件最多 10 MiB，请缩小后重试','LIMIT');
  const buffer=Buffer.alloc(before.size+1);let length=0;
  while(length<buffer.length){cancelled(signal);const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  const after=await handle.stat();cancelled(signal);
  requireThat(length===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'附件读取时发生变化，请重新选择','CONFLICT');
  return await normalizeChatAttachment(path.basename(filePath),buffer.subarray(0,length),signal);
 }catch(error){if(error instanceof AppError)throw error;throw new AppError('FILE','无法读取附件，请选择可访问的普通文件后重试');}
 finally{await handle?.close();}
}

export async function normalizeChatAttachment(fileName:string,bytes:Buffer,signal?:AbortSignal):Promise<AttachmentMaterial>{
 cancelled(signal);requireThat(typeof fileName==='string'&&fileName.length>0&&fileName.length<=255&&!fileName.includes('/')&&!fileName.includes('\\'),'附件名称无效');
 requireThat(Buffer.isBuffer(bytes)&&bytes.length<=CHAT_LIMITS.fileBytes,'附件最多 10 MiB，请缩小后重试','LIMIT');
 const name=path.basename(fileName).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255),extension=path.extname(name).toLowerCase(),kind=byteKind(bytes),length=bytes.length;
  requireThat(name.length>0,'附件名称无效');
  if(kind!=='text'){requireThat(kind==='pdf'?extension==='.pdf':imageExtensions.get(extension)===kind,'附件扩展名与真实格式不匹配','FILE');return {name,size:length,...await normalize(bytes,kind,signal)};}
  requireThat(!imageExtensions.has(extension)&&extension!=='.pdf'&&(!extension||textExtensions.has(extension)),'暂不支持此附件格式，请使用图片、PDF 或 UTF-8 文本代码','FILE');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('FILE','附件不是有效 UTF-8 文本');}
  requireThat(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),'附件包含二进制内容','FILE');requireThat(text.length<=CHAT_LIMITS.attachmentText,'附件文字最多 30,000 字符，请缩减后重试','LIMIT');
  return {name,mime:'text/plain',size:length,text};
}
