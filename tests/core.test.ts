import {describe,it,expect,beforeEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Store,atomicWrite} from '../src/main/store';
import {readCompletion,safeFetch} from '../src/main/network';
import {modelUrl,remoteUrl} from '../src/main/validation';
import {createServer} from 'node:http';
import {slotFor,nextSlot} from '../src/shared/dates';
import {checkSchema,matchesSchema} from '../src/main/mcp';
import {boundedFile} from '../src/main/components';
import {Credentials} from '../src/main/credentials';
const root=path.resolve('test-data');beforeEach(async()=>{await fs.mkdir(root,{recursive:true});});
describe('durable SQLite and read isolation',()=>{
 it('readers see only committed rows; failure rolls back memory and disk',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'workday-store-'));let fail=false;let release!:()=>void;let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);const pause=new Promise<void>(r=>release=r);
  const store=await Store.open(path.join(dir,'db.sqlite'),async(file,data)=>{if(fail){entered();await pause;throw new Error('disk full');}await atomicWrite(file,data);});
  await store.transaction(()=>store.put('settings',{id:'initial',value:1} as any));const before=await fs.readFile(store.file);fail=true;const pending=store.transaction(()=>{store.put('settings',{id:'initial',value:2} as any);expect((store.get<any>('settings','initial')).value).toBe(2);});await waiting;expect(store.get<any>('settings','initial').value).toBe(1);release();await expect(pending).rejects.toThrow('disk full');expect(store.get<any>('settings','initial').value).toBe(1);expect(await fs.readFile(store.file)).toEqual(before);store.close();await fs.rm(dir,{recursive:true});
 });
 it('credential concurrent writes preserve both encrypted entries',async()=>{const dir=await fs.mkdtemp(path.join(root,'workday-creds-'));const c=new Credentials(path.join(dir,'credentials.json'),{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>b.toString().slice(10)});await c.init();await Promise.all([c.set('a','test-a'),c.set('b','test-b')]);expect(c.get('a')).toBe('test-a');expect(c.get('b')).toBe('test-b');await fs.rm(dir,{recursive:true});});
});
describe('SSE and scope boundaries',()=>{
 it('decodes UTF8 and CRLF with every byte in a separate chunk',async()=>{const raw='data: '+JSON.stringify({choices:[{delta:{content:'中文🙂'},finish_reason:null}]})+'\r\n\r\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\r\n\r\ndata: [DONE]\r\n\r\n';const bytes=new TextEncoder().encode(raw);const stream=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});let text='';const out=await readCompletion(new Response(stream),delta=>{text+=delta;});expect(out.content).toBe('中文🙂');expect(text).toBe(out.content);});
 it('rejects partial completion and unsupported/restricted schemas',async()=>{const response=new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');await expect(readCompletion(response,()=>{})).rejects.toThrow('提前结束');expect(()=>checkSchema({type:'string',format:'email'})).toThrow('format');expect(()=>checkSchema({$ref:'https://example.com/schema'})).toThrow('$ref');expect(()=>matchesSchema({type:'object',properties:{topic:{const:'WorkDay'}},required:['topic'],additionalProperties:false},{topic:'Else'})).toThrow('允许范围');});
 it('does not accept a token-truncated answer as a completed proposal',async()=>{const response=new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');await expect(readCompletion(response,()=>{})).rejects.toThrow('未完整');});
 it('rejects path escapes and oversized imports before content read',async()=>{const dir=await fs.mkdtemp(path.join(root,'workday-path-'));await fs.writeFile(path.join(dir,'a.txt'),'okay');expect(await boundedFile(dir,'a.txt')).toBe('okay');await expect(boundedFile(dir,'../not-here.txt')).rejects.toThrow();const h=await fs.open(path.join(dir,'big.txt'),'w');await h.truncate(2*1024*1024);await h.close();await expect(boundedFile(dir,'big.txt')).rejects.toThrow('1 MB');await fs.rm(dir,{recursive:true});});
});
describe('calendar slots',()=>{
 it('uses early UTC in DST fold and marks gaps',()=>{const daily={kind:'daily' as const,time:'01:30',timezone:'America/New_York'};expect(slotFor(daily,'2026-11-01').at).toBe('2026-11-01T05:30:00.000Z');expect(slotFor({...daily,time:'02:30'},'2026-03-08').gap).toBe(true);expect(nextSlot({kind:'daily',time:'09:00',timezone:'Asia/Shanghai'},'2028-02-28T02:00:00Z')?.key).toContain('2028-02-29');expect(nextSlot({kind:'weekly',weekday:1,time:'09:00',timezone:'Asia/Shanghai'},'2026-10-12T02:00:00Z')?.key).toContain('2026-10-19');});
});
describe('model URL boundaries',()=>{
 it.each(['https://gateway.example/v1','http://gateway.example:8317/v1','http://47.84.101.180:8317/v1','http://[2001:db8::1]:8317/v1','http://localhost/v1','http://127.0.0.1:4319/v1','http://[::1]:4319/v1','http://model.test/v1%3F','http://model.test/v1%23'])('accepts HTTP/HTTPS model address %s without network access',value=>{expect(modelUrl(value)).toBeInstanceOf(URL);});
 it.each(['ftp://model.test/v1','file:///v1','javascript:alert(1)','//model.test/v1','http://','http://model.test:99999/v1','http://user:secret@model.test/v1','https://user@model.test/v1','http://model.test/v1?token=value','http://model.test/v1#part','http://model.test/v1?','http://model.test/v1#'])('rejects invalid model address %s',value=>{expect(()=>modelUrl(value)).toThrow();});
 it.each(['http://gateway.example:8317/v1','http://47.84.101.180:8317/v1','http://[2001:db8::1]:8317/v1'])('retains default non-model HTTP restriction %s',async value=>{expect(()=>remoteUrl(value)).toThrow('回环');await expect(safeFetch(value)).rejects.toThrow('回环');});
 it('does not follow authenticated HTTP redirects or deliver a fake key to the target',async()=>{
  let received=0,authorization:string|undefined;const target=createServer((req,res)=>{received++;authorization=req.headers.authorization;res.end('unexpected');});
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));const targetUrl=`http://127.0.0.1:${(target.address() as any).port}/target`;
  const redirect=createServer((req,res)=>{expect(req.headers.authorization).toBe('Bearer model-http-only-fake-key');res.writeHead(302,{Location:targetUrl});res.end();});await new Promise<void>(resolve=>redirect.listen(0,'127.0.0.1',resolve));
  try{await expect(safeFetch(`http://127.0.0.1:${(redirect.address() as any).port}/models`,{headers:{Authorization:'Bearer model-http-only-fake-key'},redirect:'follow'},modelUrl)).rejects.toThrow();expect(received).toBe(0);expect(authorization).toBeUndefined();}finally{await Promise.all([redirect,target].map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));}
 });
});
