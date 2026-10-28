import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import path from 'node:path';
import type {McpServer} from '../shared/types';
import {AppError,requireThat,remoteUrl} from './validation';
import type {Credentials} from './credentials';
export const ajv=new Ajv({strict:true,allErrors:true,validateFormats:false});
export function checkSchema(schema:Record<string,unknown>){const body=JSON.stringify(schema);requireThat(body.length<=30000,'Schema 超过上限');function visit(v:any){if(!v||typeof v!=='object')return;if('$ref'in v||'format'in v)throw new AppError('INVALID','首版不支持 $ref 或 format Schema');for(const child of Object.values(v))visit(child);}visit(schema);try{ajv.compile(schema);}catch{throw new AppError('INVALID','Schema 不兼容，请使用简单 JSON Schema');}}
export function matchesSchema(schema:Record<string,unknown>,value:unknown){checkSchema(schema);requireThat(ajv.compile(schema)(value),'参数或资源不在允许范围内','SCOPE');}
export class McpManager {
 private connections=new Map<string,{version:number;client:Client}>();
 private connecting=new Map<string,{version:number;client:Client;promise:Promise<Client>}>();
 constructor(private credentials:Credentials,private workDirectory:string){}
 async connect(server:McpServer){
  requireThat(server.enabled,'MCP 已暂停');const old=this.connections.get(server.id);if(old?.version===server.configVersion)return old.client;
  const existing=this.connecting.get(server.id);if(existing?.version===server.configVersion)return existing.promise;
  if(old||existing)await this.close(server.id);
  const concurrent=this.connecting.get(server.id);if(concurrent?.version===server.configVersion)return concurrent.promise;
  const client=new Client({name:'WorkDay',version:'0.1.0'});const pending={version:server.configVersion,client,promise:null as unknown as Promise<Client>};
  pending.promise=(async()=>{
   try{
    if(server.transport==='stdio'){
     requireThat(path.isAbsolute(server.command),'本地程序必须是绝对路径');const env:Record<string,string>={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',TMPDIR:this.workDirectory};const secret=this.credentials.get('mcp:'+server.id);if(secret)env.WORKDAY_MCP_TOKEN=secret;
     await client.connect(new StdioClientTransport({command:server.command,args:server.args,env,cwd:this.workDirectory,stderr:'ignore'}),{timeout:20000});
    }else{const u=remoteUrl(server.url);const secret=this.credentials.get('mcp:'+server.id);await client.connect(new StreamableHTTPClientTransport(u,{requestInit:{redirect:'error',headers:secret?{Authorization:'Bearer '+secret}:undefined}}),{timeout:20000});}
    requireThat(this.connecting.get(server.id)===pending,'MCP 连接已取消');this.connections.set(server.id,{version:server.configVersion,client});return client;
   }catch(error){await client.close().catch(()=>undefined);throw error;}finally{if(this.connecting.get(server.id)===pending)this.connecting.delete(server.id);}
  })();this.connecting.set(server.id,pending);return pending.promise;
 }
 async discover(server:McpServer){const c=await this.connect(server);const caps=c.getServerCapabilities();const tools=caps?.tools?(await c.listTools()).tools:[];for(const t of tools)checkSchema(t.inputSchema);return {tools,resources:caps?.resources?(await c.listResources()).resources:[],prompts:caps?.prompts?(await c.listPrompts()).prompts:[]};}
 async call(server:McpServer,name:string,args:Record<string,unknown>,signal?:AbortSignal,revalidate?:()=>void){const c=await this.connect(server);revalidate?.();requireThat(!signal?.aborted,'读取已取消','CANCELLED');const r=await c.callTool({name,arguments:args},undefined,{timeout:20000,signal});requireThat(!(r as any).isError,'工具执行失败','REMOTE');const value=JSON.stringify(r);requireThat(value.length<=30000,'工具结果超过 30 KB','LIMIT');return value;}
 async read(server:McpServer,uri:string,signal?:AbortSignal,revalidate?:()=>void){const c=await this.connect(server);revalidate?.();requireThat(!signal?.aborted,'读取已取消','CANCELLED');const r=await c.readResource({uri},{timeout:20000,signal});const value=JSON.stringify(r);requireThat(value.length<=30000,'资源超过 30 KB','LIMIT');return value;}
 async close(id:string){const old=this.connections.get(id),pending=this.connecting.get(id);this.connections.delete(id);this.connecting.delete(id);await Promise.allSettled([old?.client.close(),pending?.client.close()]);}
 async closeAll(){await Promise.all([...new Set([...this.connections.keys(),...this.connecting.keys()])].map(id=>this.close(id)));}
}
