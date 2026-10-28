import {z} from 'zod';
import {DateTime} from 'luxon';
import path from 'node:path';
export class AppError extends Error {constructor(public code:string,message:string){super(message);}}
export function requireThat(condition:unknown,message:string,code='INVALID'):asserts condition {if(!condition)throw new AppError(code,message);}
export const id=z.string().uuid();
export const text=(max=10000)=>z.string().max(max);
export const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>DateTime.fromISO(v).isValid&&DateTime.fromISO(v).toISODate()===v,'日期无效');
export const taskPriority=z.enum(['P0','P1','P2']);
export const projectId=id.nullable();
export const projectDirectory=text(4096).min(1).refine(v=>!v.includes('\0')&&(path.isAbsolute(v)||path.win32.isAbsolute(v)),'项目目录必须是绝对路径');
export const repositoryRef=z.object({provider:z.literal('github'),connectionId:id,repositoryId:z.number().int().positive().safe(),owner:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),name:z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine(v=>v!=='.'&&v!=='..'),defaultBranch:text(255).min(1).refine(v=>!/[\u0000-\u001f\u007f]/.test(v))}).strict();
export const model=z.object({sourceId:id,modelId:text(200).min(1)}).strict();
export const versionRef=z.object({id,version:z.number().int().positive()}).strict();
export const contextOwner=z.object({projectId,conversationId:id.nullable(),draftKey:id}).strict();
const mcpRef=z.object({id,configVersion:z.number().int().positive(),capabilityNames:z.array(text(300)).max(30)}).strict();
export const context=z.object({date:date.nullable(),calendarTasks:z.boolean().optional(),taskIds:z.array(id).max(100),knowledgeRefs:z.array(versionRef.extend({excerpt:text(30000).optional()})).max(20),skillRef:versionRef.nullable(),mcpRefs:z.array(mcpRef).max(10),attachmentRefs:z.array(z.object({token:id,name:text(255).min(1),mime:z.enum(['image/png','image/jpeg','application/pdf','text/plain']),size:z.number().int().min(0).max(10485760)}).strict()).max(6).optional(),conversationRefs:z.array(versionRef.extend({digest:z.string().regex(/^[a-f0-9]{64}$/)})).max(3).optional(),pluginRefs:z.array(versionRef.extend({skillId:id.nullable(),mcpRefs:z.array(mcpRef).max(10)}).strict()).max(10).optional()}).strict().refine(value=>!value.calendarTasks||value.date!==null,{path:['date'],message:'日历待办上下文需要选择日期'});
export const edit={id:id.optional(),expectedVersion:z.number().int().positive().optional()};
export const expected=z.object({id,expectedVersion:z.number().int().positive()}).strict();
export const action=z.union([
 z.object({type:z.literal('create'),title:text(300).min(1),notes:text().optional(),date,projectId}).strict(),
 z.object({type:z.literal('update'),taskId:id,expectedVersion:z.number().int().positive(),title:text(300).min(1).optional(),notes:text().optional()}).strict().refine(a=>a.title!==undefined||a.notes!==undefined),
 z.object({type:z.literal('complete'),taskId:id,expectedVersion:z.number().int().positive(),completed:z.boolean()}).strict(),
 z.object({type:z.literal('reschedule'),taskId:id,expectedVersion:z.number().int().positive(),date}).strict()
]);
export function parse<T>(schema:z.ZodType<T>,value:unknown):T {const r=schema.safeParse(value);if(!r.success)throw new AppError('INVALID','参数无效：'+r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；').slice(0,600));return r.data;}
function baseUrl(value:string):URL {let u:URL;try{u=new URL(value);}catch{throw new AppError('INVALID','URL 无效');}requireThat(!u.username&&!u.password&&!u.hash&&!u.search,'URL 不得包含凭证、查询或片段');return u;}
export function remoteUrl(value:string):URL {const u=baseUrl(value);requireThat(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)),'仅支持 HTTPS 或本机回环 HTTP');return u;}
export function modelUrl(value:string):URL {const u=baseUrl(value);requireThat(!u.href.includes('?')&&!u.href.includes('#'),'URL 不得包含查询或片段');requireThat(u.protocol==='https:'||u.protocol==='http:','模型源仅支持 HTTP 或 HTTPS');return u;}
export const spec=z.union([
 z.object({kind:z.literal('once'),date,time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timezone:text(100).refine(t=>DateTime.now().setZone(t).isValid)}).strict(),
 z.object({kind:z.literal('daily'),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timezone:text(100).refine(t=>DateTime.now().setZone(t).isValid)}).strict(),
 z.object({kind:z.literal('weekly'),weekday:z.number().int().min(1).max(7),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timezone:text(100).refine(t=>DateTime.now().setZone(t).isValid)}).strict(),
 z.object({kind:z.literal('biweekly'),startDate:date,time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timezone:text(100).refine(t=>DateTime.now().setZone(t).isValid)}).strict()
]);
export function strictUtf8(bytes:Uint8Array){requireThat(bytes.length<=1024*1024,'文件过大（最多 1 MB）');let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('INVALID','文件不是有效 UTF-8');}requireThat(!value.includes('\0')&&!/[\x01-\x08\x0e-\x1f]/.test(value),'文件包含二进制内容');return value;}

export const scheduleContext=context.refine(c=>!c.attachmentRefs?.length&&!c.conversationRefs?.length&&!c.pluginRefs?.length,'定时任务不支持附件、对话引用或插件选择');
