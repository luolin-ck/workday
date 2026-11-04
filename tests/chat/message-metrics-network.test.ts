import {it,expect,vi,afterEach} from 'vitest';
import * as network from '../../src/main/network';
const call=(signal?:AbortSignal)=>(network as any).fetchCompletion('https://metrics-fixture.invalid/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'fixture',stream:true,messages:[]}),signal});
afterEach(()=>vi.unstubAllGlobals());
it('retries exactly once only for a structured unsupported stream option before any response stream starts',async()=>{
 const bodies:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{bodies.push(JSON.parse(init.body));expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');return bodies.length===1?new Response(JSON.stringify({error:{param:'stream_options',code:'unsupported_parameter'}}),{status:400}):new Response('success');}));
 expect(await (await call()).text()).toBe('success');expect(bodies).toHaveLength(2);expect(bodies[0].stream_options).toEqual({include_usage:true});expect(bodies[1].stream_options).toBeUndefined();
});
it.each([[400,{error:{param:'model',code:'unsupported_parameter'}}],[400,{error:{message:'bad request'}}],[401,{error:{param:'stream_options',code:'unsupported_parameter'}}],[500,{error:{param:'stream_options',code:'unsupported_parameter'}}],[422,{message:'stream_options unsupported'}]])('does not replay unrelated status %s/error',async(status,error)=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify(error),{status:status as number}));vi.stubGlobal('fetch',fetch);await expect(call()).rejects.toThrow('HTTP');expect(fetch).toHaveBeenCalledOnce();
});
it('limits error reading and never replays oversized or malformed error payloads',async()=>{
 for(const body of ['bad JSON',JSON.stringify({error:{param:'stream_options',code:'unsupported_parameter',message:'x'.repeat(9000)}})]){const fetch=vi.fn(async()=>new Response(body,{status:400}));vi.stubGlobal('fetch',fetch);await expect(call()).rejects.toThrow('HTTP');expect(fetch).toHaveBeenCalledOnce();}
});
it('does not replay failed fetch or an already started SSE response',async()=>{
 const fetch=vi.fn(async()=>{throw Error('network fixture');});vi.stubGlobal('fetch',fetch);await expect(call()).rejects.toThrow('network fixture');expect(fetch).toHaveBeenCalledOnce();
 fetch.mockImplementation(async()=>new Response('data: {"error":{"param":"stream_options","code":"unsupported_parameter"}}\n\n') as never);const result=await call();await expect(network.readCompletion(result,()=>{})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});
it('checks cancellation before any fetch and immediately before fallback',async()=>{
 const c=new AbortController();c.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(call(c.signal)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 const second=new AbortController();fetch.mockImplementation(async()=>{second.abort();return new Response(JSON.stringify({error:{param:'stream_options',code:'unsupported_parameter'}}),{status:400});});await expect(call(second.signal)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
});
it('does not recursively retry when the compatibility request also fails',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{param:'stream_options',code:'unsupported_parameter'}}),{status:400}));vi.stubGlobal('fetch',fetch);await expect(call()).rejects.toThrow('HTTP 400');expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
 [503,{error:{message:'No available upstream',code:'upstream_unavailable'}},'No available upstream'],
 [401,{error:'Invalid API key'},'Invalid API key'],
 [429,{message:'Request quota exceeded'},'Request quota exceeded'],
])('keeps completion HTTP %s and its specific safe reason',async(status,body,reason)=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify(body),{status:status as number}));vi.stubGlobal('fetch',fetch);
 await expect(call()).rejects.toThrow(`HTTP ${status}：${reason}`);expect(fetch).toHaveBeenCalledOnce();
});
it('reads each failed body once and keeps the compatibility fallback error detail',async()=>{
 const responses=[new Response(JSON.stringify({error:{param:'stream_options',code:'unsupported_parameter'}}),{status:400}),new Response(JSON.stringify({error:{message:'Account quota exhausted'}}),{status:429})];
 const readers=responses.map(response=>vi.spyOn(response.body!,'getReader'));
 const fetch=vi.fn(async()=>responses[fetch.mock.calls.length-1]);vi.stubGlobal('fetch',fetch);
 await expect(call()).rejects.toThrow('HTTP 429：Account quota exhausted');expect(fetch).toHaveBeenCalledTimes(2);readers.forEach(reader=>expect(reader).toHaveBeenCalledOnce());
});
it.each([
 [null, 'application/json'],['', 'application/json'],['{invalid','application/json'],['<html><body>upstream stack</body></html>','text/html'],
 ['opaque failure','application/octet-stream'],[JSON.stringify({error:{message:'hidden binary response'}}),'application/octet-stream'],[JSON.stringify({error:{stack:'private stack',headers:{Authorization:'private'}}}),'application/json'],
 [JSON.stringify({error:{message:'x'.repeat(9000)}}),'application/json'],
])('uses an explicit no-detail fallback for unavailable or unsafe response bodies',async(body,type)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:503,headers:{'Content-Type':type}})));
 await expect(call()).rejects.toThrow('HTTP 503：服务未提供可用的错误详情');
});
it('accepts bounded plain text but does not display an HTML page mislabeled as text',async()=>{
 for(const [body,reason] of [['Gateway unavailable','Gateway unavailable'],['<!doctype html><html>proxy debug</html>','服务未提供可用的错误详情']]){
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:503,headers:{'Content-Type':'text/plain'}})));await expect(call()).rejects.toThrow(`HTTP 503：${reason}`);
 }
});
it('redacts credentials before persistence, removes controls and bounds the final HTTP message',async()=>{
 const credential='synthetic-active-credential',jwt='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature';
 const body={error:{message:`Unavailable\u0000\u001b ${credential} Bearer unrelated-secret api_key="api-secret" token=token-secret password: password-secret ${jwt} -----BEGIN PRIVATE KEY-----\nprivate-lines\n-----END PRIVATE KEY----- ${'x'.repeat(1800)}`,code:credential}};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(body),{status:503})));
 const error=await network.fetchCompletion('https://metrics-fixture.invalid/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${credential}`},body:'{}'}).then(()=>{throw new Error('Expected HTTP failure');},error=>error as Error);
 expect(error).toBeInstanceOf(Error);expect(error.message).toContain('Unavailable');expect(error.message.length).toBeLessThanOrEqual(1000);
 for(const secret of [credential,'unrelated-secret','api-secret','token-secret','password-secret',jwt,'private-lines'])expect(error.message).not.toContain(secret);
 expect(error.message).not.toMatch(/[\u0000-\u001f\u007f]/);
});
it('limits bytes and cancels/releases a failed response reader',async()=>{
 const read=vi.fn(async()=>({done:false,value:new Uint8Array(8193)})),cancel=vi.fn(async()=>{}),releaseLock=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:503,headers:new Headers(),body:{getReader:()=>({read,cancel,releaseLock})}})));
 await expect(call()).rejects.toThrow('服务未提供可用的错误详情');expect(read).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();expect(releaseLock).toHaveBeenCalledOnce();
});
it('redacts an active credential spanning the display truncation boundary',async()=>{
 const secret='synthetic-'+ 'credential'.repeat(20);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'x'.repeat(970)+secret}}),{status:503})));
 const error=await network.fetchCompletion('https://metrics-fixture.invalid/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:'{}'}).then(()=>{throw new Error('Expected HTTP failure');},error=>error as Error);
 expect(error.message.length).toBeLessThanOrEqual(1000);expect(error.message).not.toContain('synthetic');expect(error.message).not.toContain('credential');
});
it('aborts an in-flight error body read and never retries it',async()=>{
 const controller=new AbortController();let finishRead!:(part:{done:true})=>void;
 const read=vi.fn(()=>new Promise(resolve=>{finishRead=resolve;})),cancel=vi.fn(async()=>{finishRead({done:true});}),releaseLock=vi.fn();
 const fetch=vi.fn(async()=>({ok:false,status:400,headers:new Headers(),body:{getReader:()=>({read,cancel,releaseLock})}}));vi.stubGlobal('fetch',fetch);
 const pending=call(controller.signal);await Promise.resolve();await Promise.resolve();controller.abort();
 await expect(pending).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalled();expect(releaseLock).toHaveBeenCalledOnce();
});
it('preserves the generic safeFetch status-only contract',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'specific completion-only detail'}}),{status:401})));
 await expect(network.safeFetch('https://metrics-fixture.invalid/user')).rejects.toThrow(/^远端返回 HTTP 401$/);
});
