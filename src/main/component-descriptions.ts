import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {parse,requireThat} from './validation';
const entries=parse(z.array(z.object({kind:z.enum(['skill','plugin']),key:z.string().min(1).max(200),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),descriptionZh:z.string().trim().min(1).max(20000)}).strict()).max(5000),JSON.parse(readFileSync(path.join(__dirname,'component-descriptions.zh.json'),'utf8')));
const translations=new Map<string,string>();
for(const entry of entries){const key=JSON.stringify([entry.kind,entry.key,entry.sourceHash]);requireThat(!translations.has(key),'重复的中文描述词条');translations.set(key,entry.descriptionZh);}
export function supplementDescription(kind:'skill'|'plugin',key:string,description:string,existing?:string):string|undefined {
 if(existing?.trim())return existing;
 return translations.get(JSON.stringify([kind,key,createHash('sha256').update(description).digest('hex')]));
}
