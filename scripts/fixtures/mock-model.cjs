const http=require('node:http');
function createMockServer(){
 const requests=[];const failures=new Set();
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'workday-mock'}]}));}
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end();}
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push({body,authorization:req.headers.authorization});
  if(!body.stream){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'}}]}));}
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');
  const user=[...body.messages].reverse().find(m=>m.role==='user')?.content||'';const usedTool=body.messages.at(-1)?.role==='tool';
  const frame=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\r\n\r\n');
  if(user.includes('工具')&&body.tools?.length&&!usedTool){frame({tool_calls:[{index:0,id:'mock-'+requests.length,type:'function',function:{name:body.tools[0].function.name,arguments:JSON.stringify({topic:'WorkDay'})}}]});frame({},'tool_calls');return res.end('data: [DONE]\r\n\r\n');}
  if(user.includes('失败一次')&&!failures.has(user)){failures.add(user);frame({content:'部分回复'});return res.end();}
  let content=usedTool?'已读取授权工具结果。':`这是本地模拟服务的回复：${user}`;
  if(user.includes('草案')){const system=body.messages.find(m=>m.role==='system')?.content||'';const project=JSON.parse(system.match(/Current projectId: (null|"[^"]+")\./)?.[1]||'null');const selected=system.match(/Selected date: (\d{4}-\d{2}-\d{2})/)?.[1]||new Date().toISOString().slice(0,10);content='以下为待确认的草案。\n```workday-actions\n'+JSON.stringify([{type:'create',title:'整理 WorkDay 开发计划',notes:'来自本地模拟服务',date:selected,projectId:project}])+ '\n```';}
  const chunks=Array.from(content);let n=0;const timer=setInterval(()=>{if(res.destroyed){clearInterval(timer);return;}if(n<chunks.length)frame({content:chunks[n++]});else{frame({},'stop');res.end('data: [DONE]\r\n\r\n');clearInterval(timer);}},user.includes('慢')?100:2);
  res.on('close',()=>clearInterval(timer));
 });return {server,requests};
}
module.exports={createMockServer};
if(require.main===module){const mock=createMockServer();const port=Number(process.env.PORT||4319);mock.server.listen(port,'127.0.0.1',()=>console.log(`WorkDay 模拟模型源：http://127.0.0.1:${port}/v1，模型 workday-mock，无密钥。Ctrl+C 停止。`));}
