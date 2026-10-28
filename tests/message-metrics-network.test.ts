import {it,expect,vi,afterEach} from 'vitest';
import * as network from '../src/main/network';
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
