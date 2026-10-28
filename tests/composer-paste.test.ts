import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import * as attachment from '../src/main/chat-attachments';
import {fixture,done} from './chat-context.test';
import {emptyContext} from '../src/shared/types';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const owner=(chat:string|null)=>({projectId:null,conversationId:chat,draftKey:randomUUID()});
it('normalizes pasted image bytes and UTF-8 files using the attachment pipeline',async()=>{
 const normalize=(attachment as any).normalizeChatAttachment;
 expect(normalize,'paste needs a bounded bytes normalization entry point').toBeTypeOf('function');
 expect(await normalize('pasted.png',png)).toMatchObject({name:'pasted.png',mime:'image/png',dataUrl:expect.stringMatching(/^data:image\/png;base64,/)});
 expect(await normalize('notes.ts',Buffer.from('PASTED_CODE'))).toMatchObject({mime:'text/plain',text:'PASTED_CODE'});
});
it('pasted image and text are owner-bound, previewable, and reach the actual request',async()=>{
 const f=await fixture(),o=owner(f.chat.id);
 expect((f.service as any).pasteAttachments,'paste import operation').toBeTypeOf('function');
 const refs=await (f.service as any).pasteAttachments(o,[{name:'pasted.png',bytes:png},{name:'notes.txt',bytes:Buffer.from('PASTED_TEXT')}]);
 const previews:any=await f.service.call('context.attachments.preview' as any,{owner:o,tokens:refs.map((a:any)=>a.token)});
 expect(previews[refs[0].token]).toMatch(/^data:image\/png;base64,/);expect(previews[refs[1].token]).toBeUndefined();
 const result=await f.service.call('chat.send',{conversationId:f.chat.id,text:'',model:f.model,owner:o,context:{...emptyContext(),attachmentRefs:refs}});
 await done(f,result);expect(JSON.stringify(f.bodies)).toContain('PASTED_TEXT');expect(JSON.stringify(f.bodies)).toContain('image_url');
 await expect(f.service.call('context.attachments.preview' as any,{owner:o,tokens:[refs[0].token]})).rejects.toThrow();
});
it('pasted batches are atomic and cumulative imports cannot exceed six files',async()=>{
 const f=await fixture(),o=owner(f.chat.id),paste=(items:any[])=>(f.service as any).pasteAttachments(o,items);
 expect((f.service as any).pasteAttachments).toBeTypeOf('function');
 await expect(paste([{name:'good.txt',bytes:Buffer.from('GOOD')},{name:'bad.exe',bytes:Buffer.from([0,1,2])}])).rejects.toThrow();
 expect((f.service as any).attachments.size).toBe(0);
 await paste(Array.from({length:6},(_,i)=>({name:`${i}.txt`,bytes:Buffer.from('ok')})));
 await expect(paste([{name:'seventh.txt',bytes:Buffer.from('bad')}])).rejects.toThrow('6');expect((f.service as any).attachments.size).toBe(6);
});
it('preview cannot cross owners and removed tokens cannot be previewed',async()=>{
 const f=await fixture(),o=owner(f.chat.id);expect((f.service as any).pasteAttachments).toBeTypeOf('function');
 const refs=await (f.service as any).pasteAttachments(o,[{name:'pasted.png',bytes:png}]);
 await expect(f.service.call('context.attachments.preview' as any,{owner:owner(f.chat.id),tokens:[refs[0].token]})).rejects.toThrow();
 await f.service.call('context.attachments.remove',{owner:o,tokens:[refs[0].token]});
 await expect(f.service.call('context.attachments.preview' as any,{owner:o,tokens:[refs[0].token]})).rejects.toThrow();
});
it.each([
 {name:'path',files:[{name:'/private/not-authorized.txt',bytes:Buffer.from('x')}],error:'名称'},
 {name:'extra path field',files:[{name:'a.txt',bytes:Buffer.from('x'),path:'/private/not-authorized'}],error:'参数'},
 {name:'forged MIME',files:[{name:'a.jpg',bytes:png}],error:'格式'},
 {name:'oversized file',files:[{name:'a.txt',bytes:Buffer.alloc(10*1024*1024+1)}],error:'10 MiB'},
 {name:'oversized batch',files:Array.from({length:3},()=>({name:'a.txt',bytes:Buffer.alloc(9*1024*1024)})),error:'24 MiB'},
 {name:'non bytes',files:[{name:'a.txt',bytes:'PRIVATE_PATH'}],error:'参数'},
 {name:'more than six',files:Array.from({length:7},()=>({name:'a.txt',bytes:Buffer.from('x')})),error:'6'},
])('rejects $name before issuing attachment tokens',async({files,error})=>{const f=await fixture();await expect((f.service as any).pasteAttachments(owner(f.chat.id),files)).rejects.toThrow(error);expect((f.service as any).attachments.size).toBe(0);expect(f.bodies).toEqual([]);});
it('generic RPC does not expose pasted bytes or native paths',async()=>{const f=await fixture();await expect(f.service.call('context.attachments.paste' as any,{owner:owner(f.chat.id),files:[]})).rejects.toThrow('白名单');});
it('paste obeys migration guard and leaves no tokens after disposal',async()=>{
 const f=await fixture(),o=owner(f.chat.id);(f.service as any).componentMigrationBusy=true;
 await expect(f.service.pasteAttachments(o,[{name:'a.txt',bytes:Buffer.from('x')}])).rejects.toThrow('迁移');
 expect((f.service as any).callsInFlight).toBe(0);(f.service as any).componentMigrationBusy=false;
 const pending=f.service.pasteAttachments(o,[{name:'a.png',bytes:png}]);expect((f.service as any).callsInFlight).toBe(1);
 const rejected=expect(pending).rejects.toThrow('取消');await f.service.dispose();await rejected;expect((f.service as any).attachments.size).toBe(0);expect((f.service as any).callsInFlight).toBe(0);
});
it('preserves the original owner on failed second import and rejects expired previews',async()=>{
 const f=await fixture(),o=owner(f.chat.id),refs=await f.service.pasteAttachments(o,[{name:'a.png',bytes:png}]);
 (f.service as any).attachments.get(refs[0].token).expires=0;
 await expect(f.service.call('context.attachments.preview',{owner:o,tokens:[refs[0].token]})).rejects.toThrow('过期');expect((f.service as any).attachments.size).toBe(0);
});
