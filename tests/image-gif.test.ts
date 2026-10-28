import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';

let root='',helper='';
function crc(data:Buffer){let v=0xffffffff;for(const byte of data){v^=byte;for(let i=0;i<8;i++)v=(v>>>1)^((v&1)?0xedb88320:0);}return (v^0xffffffff)>>>0;}
function png(width:number,height:number,blank=false,duplicate=false){
 const chunk=(type:string,data:Buffer)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const pixels=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const frame=duplicate?0:Math.floor(y/(height/4))*6+Math.floor(x/(width/6)),i=y*(width*4+1)+1+x*4;
  pixels[i]=blank?255:(frame*9+(x%8)*2)%256;pixels[i+1]=blank?255:(frame*5+(y%8)*4)%256;pixels[i+2]=blank?255:200-frame*5;pixels[i+3]=255;
 }
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function rgba(encoded:Buffer){
 const width=encoded.readUInt32BE(16),height=encoded.readUInt32BE(20),channels=encoded[25]===6?4:3,parts:Buffer[]=[];
 expect(encoded[24]).toBe(8);expect([2,6]).toContain(encoded[25]);
 for(let i=8;i<encoded.length;){const size=encoded.readUInt32BE(i);if(encoded.toString('ascii',i+4,i+8)==='IDAT')parts.push(encoded.subarray(i+8,i+8+size));i+=12+size;}
 const raw=inflateSync(Buffer.concat(parts)),rows=Buffer.alloc(width*height*channels),stride=width*channels;
 for(let y=0;y<height;y++)for(let x=0;x<stride;x++){
  const filter=raw[y*(stride+1)],left=x>=channels?rows[y*stride+x-channels]:0,up=y?rows[(y-1)*stride+x]:0,corner=y&&x>=channels?rows[(y-1)*stride+x-channels]:0,p=left+up-corner,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-corner);
  const prediction=[0,left,up,Math.floor((left+up)/2),pa<=pb&&pa<=pc?left:pb<=pc?up:corner][filter];expect(prediction).toBeDefined();rows[y*stride+x]=(raw[y*(stride+1)+1+x]+prediction)%256;
 }
 const result=Buffer.alloc(width*height*4);for(let p=0;p<width*height;p++){rows.copy(result,p*4,p*channels,p*channels+3);result[p*4+3]=channels===4?rows[p*channels+3]:255;}return {width,height,data:result};
}
async function fixture(bytes=png(48,32)){const directory=await fs.mkdtemp(path.join(root,'job-')),sourcePath=path.join(directory,'sheet.png');await fs.writeFile(sourcePath,bytes);return {directory,sourcePath};}
function run(request:unknown){const result=spawnSync(helper,[],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:65536});let body;try{body=JSON.parse(result.stdout);}catch{throw new Error(JSON.stringify({code:result.status,signal:result.signal,stderr:result.stderr,error:result.error?.message}));}return {code:result.status,body,stderr:result.stderr};}
beforeAll(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'workday-image-gif-tests-')));helper=path.join(root,'image-gif');execFileSync(process.execPath,['-e','require("./scripts/build-image-gif.cjs").buildImageGif(process.argv[1]).catch(e=>{console.error(e);process.exitCode=1})',helper],{cwd:path.resolve(__dirname,'..'),stdio:'inherit'});},120000);
afterAll(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});

describe('native crop and GIF codec with synthetic fixtures (no AI generation)',()=>{
 it('decodes a real PNG, exactly crops row-major 24 frames and re-decodes ordered 24-frame GIF',async()=>{
  const source=png(48,32),f=await fixture(source),sourcePixels=rgba(source),inspect=run({operation:'inspect',sourcePath:f.sourcePath,outputDir:f.directory});
  expect(inspect,JSON.stringify(inspect)).toMatchObject({code:0});expect(inspect.body).toMatchObject({ok:true,mime:'image/png',width:48,height:32,frameCount:1});
  const result=run({operation:'compose',sourcePath:f.sourcePath,outputDir:f.directory,columns:6,rows:4,frameCount:24,delayMs:100,loop:0});
  expect(result,JSON.stringify(result)).toMatchObject({code:0});expect(result.stderr).toBe('');expect(result.body.frames).toHaveLength(24);expect(new Set(result.body.frames.map((v:any)=>v.sha256)).size).toBe(24);
  expect(result.body.frames[0]).toMatchObject({index:1,x:0,y:0,width:8,height:8});expect(result.body.frames[23]).toMatchObject({index:24,x:40,y:24,width:8,height:8});
  for(const frame of result.body.frames){const bytes=await fs.readFile(frame.path),cropped=rgba(bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(frame.sha256);for(let y=0;y<8;y++)expect(cropped.data.subarray(y*32,(y+1)*32)).toEqual(sourcePixels.data.subarray(((frame.y+y)*48+frame.x)*4,((frame.y+y)*48+frame.x+8)*4));expect(run({operation:'inspect',sourcePath:frame.path,outputDir:f.directory}).body).toMatchObject({ok:true,mime:'image/png',width:8,height:8,frameCount:1});}
  const gif=run({operation:'inspect',sourcePath:result.body.gif.path,outputDir:f.directory});expect(gif.code).toBe(0);expect(gif.body).toMatchObject({ok:true,mime:'image/gif',width:8,height:8,frameCount:24,delayMs:100,loop:0});
  expect(result.body.gif).toMatchObject({width:8,height:8,frameCount:24,delayMs:100,loop:0});expect((await fs.readdir(f.directory)).filter(v=>v.startsWith('.'))).toEqual([]);
 });
 it.each([['not divisible',()=>png(47,32)],['blank',()=>png(48,32,true)],['duplicate',()=>png(48,32,false,true)]])('rejects %s sheets without publishing partial files',async(_label,make)=>{
  const f=await fixture(make()),result=run({operation:'compose',sourcePath:f.sourcePath,outputDir:f.directory});expect(result.code).toBe(1);expect(result.body.ok).toBe(false);expect((await fs.readdir(f.directory)).sort()).toEqual(['sheet.png']);
 });
 it('rejects path escape, symlink, nonregular source and invalid images',async()=>{
  const f=await fixture(),outside=await fixture(),link=path.join(f.directory,'link.png');await fs.symlink(outside.sourcePath,link);await fs.mkdir(path.join(f.directory,'folder.png'));await fs.writeFile(path.join(f.directory,'bad.png'),'not an image');
  for(const sourcePath of [outside.sourcePath,link,path.join(f.directory,'folder.png'),path.join(f.directory,'bad.png'),f.directory+'/../'+path.basename(f.directory)+'/sheet.png']){const r=run({operation:'inspect',sourcePath,outputDir:f.directory});expect(r.code).toBe(1);expect(r.body.ok).toBe(false);}
 });
 it('rejects unsafe parameters, extra fields, symlink roots, oversized PNG headers and existing outputs',async()=>{
  const f=await fixture(),base={operation:'compose',sourcePath:f.sourcePath,outputDir:f.directory};
  for(const extra of [{columns:5},{rows:3},{frameCount:25},{delayMs:1},{delayMs:25},{loop:-1},{columns:true},{unknown:'field'}])expect(run({...base,...extra})).toMatchObject({code:1,body:{ok:false}});
  const header=png(9000,1),big=await fixture(header);expect(run({operation:'inspect',sourcePath:big.sourcePath,outputDir:big.directory})).toMatchObject({code:1,body:{ok:false,code:'LIMIT'}});
  const link=path.join(root,'alias');await fs.symlink(f.directory,link);expect(run({operation:'inspect',sourcePath:link+'/sheet.png',outputDir:link})).toMatchObject({code:1,body:{ok:false}});
  await fs.mkdir(path.join(f.directory,'frames'));expect(run(base)).toMatchObject({code:1,body:{ok:false,code:'EXISTS'}});expect((await fs.readdir(f.directory)).sort()).toEqual(['frames','sheet.png']);
 });
});
