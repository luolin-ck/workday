import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const script=stripTypeScriptTypes(fs.readFileSync('src/preload/index.ts','utf8')).replace("import {contextBridge,ipcRenderer} from 'electron';","const {contextBridge,ipcRenderer}=require('electron');");
function fixture(){
 let listener:any,bridge:any;const invoke=vi.fn(async()=>({ok:true,value:[]}));
 class Textarea {disabled=false;readOnly=false;matches=()=>true;}
 const target=new Textarea(),document={activeElement:target};
 vm.runInNewContext(script,{exports:{},Uint8Array,Date,Array,Symbol,HTMLTextAreaElement:Textarea,document,window:{addEventListener:(name:string,fn:any,capture:boolean)=>{expect(name).toBe('paste');expect(capture).toBe(true);listener=fn;}},require:(name:string)=>{expect(name).toBe('electron');return {ipcRenderer:{invoke,on:vi.fn(),removeListener:vi.fn()},contextBridge:{exposeInMainWorld:(_name:string,value:any)=>bridge=value}};}});
 const event=(files:any[],extra={})=>listener({isTrusted:true,target,clipboardData:{files},...extra});
 const file=(size=3)=>({name:'fixture.txt',size,arrayBuffer:vi.fn(async()=>new Uint8Array([65,66,67]).buffer)});
 return {bridge,invoke,event,file,target,document};
}
it('private handoff rejects a synthetic event, missing event, wrong target and plain text',async()=>{
 const f=fixture();expect((await f.bridge.pasteAttachments({})).ok).toBe(false);
 f.event([f.file()],{isTrusted:false});expect((await f.bridge.pasteAttachments({})).ok).toBe(false);
 f.event([f.file()],{target:{}});expect((await f.bridge.pasteAttachments({})).ok).toBe(false);
 f.event([]);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);expect(f.invoke).not.toHaveBeenCalled();
});
it('consumes a trusted focused composer event once and reads only that event files',async()=>{
 const f=fixture(),file=f.file(),owner={projectId:null,conversationId:null,draftKey:'fixture'};f.event([file]);
 expect((await f.bridge.pasteAttachments(owner)).ok).toBe(true);expect((await f.bridge.pasteAttachments(owner)).ok).toBe(false);expect(file.arrayBuffer).toHaveBeenCalledOnce();
 expect(f.invoke).toHaveBeenCalledOnce();const [channel,sentOwner,files]=f.invoke.mock.calls[0] as any;expect(channel).toBe('workday:paste');expect(sentOwner).toEqual(owner);expect([...files[0].bytes]).toEqual([65,66,67]);expect(Object.keys(files[0])).toEqual(['name','bytes']);
});
it.each(['unfocused','disabled','readonly','noncomposer'])('does not capture from %s inputs',async mode=>{const f=fixture(),file=f.file();if(mode==='unfocused')f.document.activeElement={} as any;if(mode==='disabled')f.target.disabled=true;if(mode==='readonly')f.target.readOnly=true;if(mode==='noncomposer')f.target.matches=()=>false;f.event([file]);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);expect(file.arrayBuffer).not.toHaveBeenCalled();});
it.each(['count','single','total'])('enforces %s limit before File arrayBuffer and IPC',async mode=>{const f=fixture(),files=mode==='count'?Array.from({length:7},()=>f.file()):mode==='single'?[f.file(10*1024*1024+1)]:Array.from({length:3},()=>f.file(9*1024*1024));f.event(files);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);for(const file of files)expect(file.arrayBuffer).not.toHaveBeenCalled();expect(f.invoke).not.toHaveBeenCalled();});
it('expires unconsumed handoffs and consumes even a failed read without replay',async()=>{const f=fixture();f.event([f.file()]);const now=Date.now;Date.now=()=>now()+2000;try{expect((await f.bridge.pasteAttachments({})).ok).toBe(false);}finally{Date.now=now;}const file=f.file();file.arrayBuffer.mockRejectedValueOnce(Error('unreadable'));f.event([file]);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);expect(f.invoke).not.toHaveBeenCalled();});
it('changes in the focused element revoke an unconsumed paste and byte mismatches fail closed',async()=>{
 const f=fixture();f.event([f.file()]);f.document.activeElement={} as any;expect((await f.bridge.pasteAttachments({})).ok).toBe(false);
 f.document.activeElement=f.target;f.event([f.file(2)]);expect((await f.bridge.pasteAttachments({})).ok).toBe(false);expect(f.invoke).not.toHaveBeenCalled();
});
