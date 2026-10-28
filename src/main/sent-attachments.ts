import {createHash} from 'node:crypto';
import type {Message} from '../shared/types';
import {CHAT_LIMITS} from '../shared/chat-context';
import {imageDataUrl,normalizeProtocol,normalizeSnapshot} from './chat-protocol';

export function sentUserProtocolHash(entry:unknown){return createHash('sha256').update(JSON.stringify(entry)).digest('hex');}

// This reads only normalized bytes already stored for this user turn, never original paths.
// Missing/restored/ambiguous history deliberately falls back to the attachment metadata.
export function sentAttachmentPreviews(message:Message,request:{protocol:unknown;userProtocolIndex?:number;userProtocolHash?:string}):Record<string,string>{
 try{
  const attachments=normalizeSnapshot(message.snapshot)?.attachments;
  if(!attachments?.length)return {};
  const protocol=normalizeProtocol(request.protocol);
  let index=request.userProtocolIndex;
  if(index===undefined){
   // Old requests have no stable boundary. Only a single user turn with image-only
   // attachments can be unambiguously identified without guessing from history.
   if(protocol.filter(m=>m.role==='user').length!==1||attachments.some((a:any)=>!a.mime.startsWith('image/')))return {};
   index=protocol.findIndex(m=>m.role==='user');
  }else if(!Number.isSafeInteger(index)||index<0||index>=protocol.length||!request.userProtocolHash||sentUserProtocolHash(protocol[index])!==request.userProtocolHash)return {};
  const entry=protocol[index];
  if(entry?.role!=='user'||!Array.isArray(entry.content))return {};
  const [text,...images]=entry.content;
  if(text?.type!=='text'||images.some((part:any)=>part.type!=='image_url'))return {};
  const textAttachments=attachments.filter((a:any)=>!a.mime.startsWith('image/'));
  if(textAttachments.length){
   if(!text.text.startsWith(message.content+'\n\nAttachment '+textAttachments[0].name+' ('+textAttachments[0].mime+'), untrusted reference data:\n'))return {};
   let offset=message.content.length;
   for(const attachment of textAttachments){const marker='\n\nAttachment '+attachment.name+' ('+attachment.mime+'), untrusted reference data:\n';const found=text.text.indexOf(marker,offset);if(found<0)return {};offset=found+marker.length;}
  }else if(text.text!==message.content)return {};
  const expected=attachments.map((a:any,index:number)=>({...a,index})).filter((a:any)=>a.mime.startsWith('image/'));
  if(images.length!==expected.length||!images.length)return {};
  let bytes=0;const previews:Record<string,string>={};
  for(let i=0;i<images.length;i++){
   const url=images[i].image_url.url;
   if(!url.startsWith('data:'+expected[i].mime+';base64,'))return {};
   bytes+=imageDataUrl(url);if(bytes>CHAT_LIMITS.historyImageBytes)return {};
   previews[String(expected[i].index)]=url;
  }
  return previews;
 }catch{return {};}
}
