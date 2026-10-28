import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ComponentKind,ComponentIntent,Conversation} from '../shared/types';

/** Private application instructions. These are never installed or selected as user Skills. */
export interface PlatformCapability {key:string;kind:ComponentKind;version:number;instructions:string;files:Record<string,string>;digest:string}
const kinds:ComponentKind[]=['skill','mcp','plugin'];
const capabilities=kinds.map(kind=>{
 const root=path.join(__dirname,'platform-capabilities',kind);
 const instructions=readFileSync(path.join(root,'instructions.md'),'utf8');
 const files={'instructions.md':instructions,'references/format.md':readFileSync(path.join(root,'references/format.md'),'utf8'),'references/description-zh.md':readFileSync(path.join(__dirname,'platform-capabilities','description-zh.md'),'utf8')};
 return {key:'workday.components.'+kind,kind,version:1,instructions,files,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
});
export const platformCapability=(kind:ComponentKind):PlatformCapability=>capabilities.find(c=>c.kind===kind)!;
/** Read/reject compatibility only; no legacy ID resolves to a Skill or grants a session. */
export const legacyComponentKind=(id:string|null|undefined):ComponentKind|undefined=>kinds.find((_,i)=>id===`b17d0000-0000-4000-8000-00000000000${i+1}`);
export function componentMode(c:Pick<Conversation,'context'|'componentMode'>):{kind:ComponentKind;intent:ComponentIntent}|undefined {
 if(c.componentMode)return c.componentMode;
 const kind=legacyComponentKind(c.context.skillRef?.id);return kind?{kind,intent:'create'}:undefined;
}
