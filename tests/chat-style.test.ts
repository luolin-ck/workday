import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixture,done} from './chat-context.test';
import {emptyContext} from '../src/shared/types';
import {sentAttachmentPreviews,sentUserProtocolHash} from '../src/main/sent-attachments';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKK+lPmz//Z','base64');
async function sent(f:Awaited<ReturnType<typeof fixture>>,text='SYNTHETIC_CURRENT_IMAGE'){
 const owner={projectId:null,conversationId:f.chat.id,draftKey:randomUUID()};
 const refs=await f.service.pasteAttachments(owner,[{name:'same.png',bytes:png},{name:'notes.txt',bytes:Buffer.from('SYNTHETIC_TEXT')},{name:'same.png',bytes:png}]);
 const result=await f.service.call('chat.send',{conversationId:f.chat.id,text,model:f.model,owner,context:{...emptyContext(),attachmentRefs:refs}});
 await done(f,result);return result;
}
it('reads only the bound sent message images by complete attachment index after tokens are consumed',async()=>{
 const f=await fixture(),first=await sent(f),second=await sent(f,'NEXT_IMAGE');
 const preview=await f.service.call('messages.attachments.preview' as any,{conversationId:f.chat.id,messageId:second.userMessageId});
 expect(Object.keys(preview)).toEqual(['0','2']);
 expect((preview as any)['0']).toMatch(/^data:image\/png;base64,/);
 const request=f.store.get<any>('requests',second.requestId);
 expect(request.userProtocolIndex).toBeGreaterThan(f.store.get<any>('requests',first.requestId).userProtocolIndex);
 expect(request.protocol[request.userProtocolIndex].content[0].text).toMatch(/^NEXT_IMAGE/);
 expect((f.service as any).attachments.size).toBe(0);
 const calls=f.bodies.length;
 await f.service.call('messages.attachments.preview' as any,{conversationId:f.chat.id,messageId:first.userMessageId});
 expect(f.bodies).toHaveLength(calls);
});
it('rejects cross-conversation, non-user and foreign request bindings and extra input',async()=>{
 const f=await fixture(),result=await sent(f),request=f.store.get<any>('requests',result.requestId);
 const other=await f.service.call('conversations.create',{projectId:null,date:null,model:f.model});
 const read=(input:any)=>f.service.call('messages.attachments.preview' as any,input);
 await expect(read({conversationId:other.id,messageId:result.userMessageId})).rejects.toThrow();
 await expect(read({conversationId:f.chat.id,messageId:request.assistantMessageId})).rejects.toThrow();
 await expect(read({conversationId:f.chat.id,messageId:result.userMessageId,path:'/private/forbidden'})).rejects.toThrow('参数');
 for(const change of [{conversationId:other.id},{userMessageId:randomUUID()}]){
  await f.store.transaction(()=>f.store.put('requests',{...request,...change,id:request.id}));
  await expect(read({conversationId:f.chat.id,messageId:result.userMessageId})).rejects.toThrow();
 }
});
it('keeps the exact user protocol index after project user results and across retry',async()=>{
 const f=await fixture(),result=await sent(f),request=f.store.get<any>('requests',result.requestId);
 request.protocol.push({role:'user',content:'PROJECT_TOOL_RESULT'});
 request.status='failed';
 await f.store.transaction(()=>f.store.put('requests',request));
 expect(Object.keys(await f.service.call('messages.attachments.preview',{conversationId:f.chat.id,messageId:result.userMessageId}))).toEqual(['0','2']);
 const retry=await f.service.call('chat.retry',{conversationId:f.chat.id,userMessageId:result.userMessageId});await done(f,retry);
 const retried=f.store.get<any>('requests',retry.requestId);
 expect(retried.userProtocolIndex).toBe(request.userProtocolIndex);expect(retried.userProtocolHash).toBe(request.userProtocolHash);
});
it('falls back without writes or requests when restored request data is absent',async()=>{
 const f=await fixture(),result=await sent(f);await f.store.transaction(()=>f.store.remove('requests',result.requestId));
 const before=JSON.stringify(f.store.exportRows()),calls=f.bodies.length;
 expect(await f.service.call('messages.attachments.preview',{conversationId:f.chat.id,messageId:result.userMessageId})).toEqual({});
 expect(JSON.stringify(f.store.exportRows())).toBe(before);expect(f.bodies).toHaveLength(calls);
});
function protocolFixture(){
 const url='data:image/png;base64,'+png.toString('base64');
 const entry={role:'user',content:[{type:'text',text:'ORIGINAL_TEXT'},{type:'image_url',image_url:{url}}]};
 return {message:{id:randomUUID(),conversationId:randomUUID(),requestId:randomUUID(),role:'user',content:'ORIGINAL_TEXT',status:'complete',createdAt:new Date().toISOString(),snapshot:{attachments:[{name:'same.png',mime:'image/png',size:png.length}]}} as any,request:{protocol:[entry],userProtocolIndex:0,userProtocolHash:sentUserProtocolHash(entry)} as any,url};
}
it.each(['negative-index','overflow-index','wrong-role','wrong-text','missing-hash','changed-index','remote','file','svg','noncanonical','large-image','dimensions','mime','image-count','metadata-count','parts','stripped'])('returns no partial previews for %s',mode=>{
 const f=protocolFixture(),entry=f.request.protocol[0];
 if(mode==='negative-index')f.request.userProtocolIndex=-1;
 if(mode==='overflow-index')f.request.userProtocolIndex=42;
 if(mode==='wrong-role')entry.role='assistant';
 if(mode==='wrong-text')entry.content[0].text='OTHER_TEXT';
 if(mode==='missing-hash')delete f.request.userProtocolHash;
 if(mode==='changed-index'){f.request.protocol.unshift({...entry,content:[{type:'text',text:'ORIGINAL_TEXT'}, {type:'image_url',image_url:{url:f.url.replace('image/png','image/jpeg')}}]});}
 if(mode==='remote')entry.content[1].image_url.url='https://remote.invalid/private.png';
 if(mode==='file')entry.content[1].image_url.url='file:///private/image.png';
 if(mode==='svg')entry.content[1].image_url.url='data:image/svg+xml;base64,PHN2Zy8+';
 if(mode==='noncanonical')entry.content[1].image_url.url=f.url+'=';
 if(mode==='large-image')entry.content[1].image_url.url='data:image/png;base64,'+Buffer.alloc(4*1024*1024+1).toString('base64');
 if(mode==='dimensions'){const bytes=Buffer.from(png);bytes.writeUInt32BE(4096,16);entry.content[1].image_url.url='data:image/png;base64,'+bytes.toString('base64');}
 if(mode==='mime')f.message.snapshot.attachments[0].mime='image/jpeg';
 if(mode==='image-count')entry.content.push(entry.content[1]);
 if(mode==='metadata-count')f.message.snapshot.attachments=Array.from({length:7},()=>f.message.snapshot.attachments[0]);
 if(mode==='parts')entry.content.splice(1,0,{type:'text',text:'EXTRA_TEXT'});
 if(mode==='stripped')entry.content='ORIGINAL_TEXT';
 if(!['missing-hash','changed-index'].includes(mode))f.request.userProtocolHash=sentUserProtocolHash(entry);
 expect(sentAttachmentPreviews(f.message,f.request)).toEqual({});
});
it('restores only an unambiguous image-only legacy turn and never picks later project/history users',()=>{
 const f=protocolFixture();delete f.request.userProtocolIndex;delete f.request.userProtocolHash;
 expect(sentAttachmentPreviews(f.message,f.request)).toEqual({'0':f.url});
 f.request.protocol.push({role:'user',content:'PROJECT_RESULT'});expect(sentAttachmentPreviews(f.message,f.request)).toEqual({});
 f.request.protocol=[f.request.protocol[0],f.request.protocol[0]];expect(sentAttachmentPreviews(f.message,f.request)).toEqual({});
});
it('accepts normalized JPEG bytes only with matching attachment MIME',()=>{
 const f=protocolFixture(),bytes=jpeg;
 const url='data:image/jpeg;base64,'+bytes.toString('base64');f.request.protocol[0].content[1].image_url.url=url;
 f.request.userProtocolHash=sentUserProtocolHash(f.request.protocol[0]);f.message.snapshot.attachments[0]={name:'same.jpg',mime:'image/jpeg',size:bytes.length};
 expect(sentAttachmentPreviews(f.message,f.request)).toEqual({'0':url});
});

it('normalizes a real JPEG, sends it, and previews the frozen normalized data after consumption',async()=>{
 const f=await fixture(),owner={projectId:null,conversationId:f.chat.id,draftKey:randomUUID()};
 const refs=await f.service.pasteAttachments(owner,[{name:'photograph.jpg',bytes:jpeg}]);
 const pending=await f.service.call('context.attachments.preview',{owner,tokens:[refs[0].token]});
 const result=await f.service.call('chat.send',{conversationId:f.chat.id,text:'JPEG_REFERENCE',model:f.model,owner,context:{...emptyContext(),attachmentRefs:refs}});await done(f,result);
 expect(await f.service.call('messages.attachments.preview',{conversationId:f.chat.id,messageId:result.userMessageId})).toEqual({'0':pending[refs[0].token]});
});
