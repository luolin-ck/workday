import {z} from 'zod';
import {DateTime} from 'luxon';
import {id,text,date,taskPriority,projectId,projectDirectory,repositoryRef,model,context,contextOwner,scheduleContext,edit,expected,action,spec} from './validation';
const object=(shape:z.ZodRawShape)=>z.object(shape).strict();const toggle=expected.extend({enabled:z.boolean()});
const scope={scopeType:z.enum(['conversation','schedule']),scopeId:id};
const modelEntry=object({id:text(200).min(1),name:text(200).min(1),supportsTools:z.boolean()});
const holidayYear=z.number().int().min(2000).max(2100);
const weatherText=z.string().max(120).refine(v=>v.trim().length>0&&!/[\u0000-\u001f\u007f]/.test(v)).transform(v=>v.trim());
export const weatherLocation=z.object({name:weatherText,country:weatherText,region:weatherText.optional(),latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180),timezone:z.string().max(100).refine(v=>{if(!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(v))return false;try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}})}).strict();
export const schemas:Record<string,z.ZodTypeAny>={
 'components.start':object({kind:z.enum(['skill','mcp','plugin']),intent:z.enum(['create','import'])}),
 'components.end':object({conversationId:id}),
 'components.session':object({conversationId:id}),'components.chooseMaterial':object({conversationId:id}),
 'components.removeMaterial':object({conversationId:id,token:id}),
 'components.confirm':object({draftId:id,expectedVersion:z.number().int().positive()}),'components.discard':object({draftId:id,expectedVersion:z.number().int().positive()}),
 'components.readDraftFile':object({draftId:id,path:text(1000).min(1),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(12000).optional()}),
 'security.keychain.status':object({}), 'security.keychain.configure':object({}), 'security.keychain.open':object({}),
 'meetings.query':object({startDate:date,endDate:date,timezone:z.string().max(100).refine(v=>/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(v)&&DateTime.now().setZone(v).isValid),requestAccess:z.boolean().optional()}).refine(v=>{const days=DateTime.fromISO(v.endDate,{zone:'UTC'}).diff(DateTime.fromISO(v.startDate,{zone:'UTC'}),'days').days;return days>0&&days<=42;},'查询范围须为 1 至 42 天'),
 'state.get':object({}), 'tasks.save':object({...edit,priority:taskPriority.optional(),title:text(300).min(1),notes:text(),date,dueDate:date.nullable().optional(),projectId,completed:z.boolean(),completedDate:date.nullable().optional()}).refine(task=>!task.completed||task.completedDate!==null,'已完成事项须有完成日期'),
 'weather.search':object({query:z.string().max(80).refine(v=>v.trim().length>=2&&!/[\u0000-\u001f\u007f]/.test(v)).transform(v=>v.trim())}),'weather.query':object({date,location:weatherLocation.nullable(),refresh:z.boolean().optional()}),
 'holidays.query':object({year:holidayYear,refresh:z.boolean().optional()}),'holidays.openSource':object({year:holidayYear}),
 'tasks.delete':expected,'tasks.restore':expected,
 'git.connect':object({secret:z.string().min(1).max(1024).refine(v=>!/[\s\u0000-\u001f\u007f]/.test(v),'令牌不得包含空格或控制字符')}),
 'git.disconnect':object({connectionId:id}),'git.repositories':object({connectionId:id,page:z.number().int().min(1).max(10000)}),'git.preview':object({projectId:id,paths:z.array(text(512).min(1)).min(1).max(5)}),'git.import':object({token:id}),'git.openSettings':object({}),
 'projects.pickDirectory':object({}),
 'projects.save':object({...edit,name:text(100).min(1),description:text(),directory:projectDirectory.nullable(),repository:repositoryRef.nullable().optional()}),'projects.download':expected,'projects.archive':expected.extend({archived:z.boolean()}),
 'conversations.create':object({title:text(200).optional(),projectId,date:date.nullable(),model:model.nullable()}),
 'conversations.rename':expected.extend({title:text(200).min(1)}),'conversations.move':expected.extend({projectId}),
 'conversations.archive':expected.extend({archived:z.boolean()}),
 'conversations.history':object({id}),'conversations.context':expected.extend({context}),
 'context.attachments.preview':object({owner:contextOwner,tokens:z.array(id).max(6)}),'context.attachments.pick':object({owner:contextOwner}),'context.attachments.remove':object({owner:contextOwner,tokens:z.array(id).max(6)}),'context.attachments.transfer':object({owner:contextOwner,conversationId:id,tokens:z.array(id).min(1).max(6)}),'context.conversations':object({owner:contextOwner,query:text(200)}),
 'messages.attachments.preview':object({conversationId:id,messageId:id}),
 'media.read':object({messageId:id,artifactId:id}),'media.open':object({messageId:id,artifactId:id,directory:z.boolean().optional()}),
 'chat.send':object({conversationId:id,text:text(30000),model,context,owner:contextOwner.optional(),toolHistoryAsText:z.boolean().optional()}).refine(p=>p.text.trim().length>0||!!p.context.attachmentRefs?.length,'请输入消息或添加附件'),
 'chat.retry':object({conversationId:id,userMessageId:id}),'chat.continue':object({conversationId:id,requestId:id}),'chat.cancel':object({requestId:id}),
 'drafts.save':expected.extend({actions:z.array(action).min(1).max(50),confirmProject:z.boolean().optional()}),'drafts.apply':expected,'drafts.discard':expected,
 'sources.save':object({...edit,name:text(100).min(1),baseUrl:text(1000),models:z.array(modelEntry).max(100),secret:text(4096).optional()}),
 'sources.delete':expected,
 'sources.toggle':toggle,'sources.models':object({id}),'sources.test':object({id,modelId:text(200).min(1)}),'settings.defaultModel':object({model:model.nullable()}),
 'knowledge.save':object({...edit,name:text(200).min(1),content:text(1000000),projectId}),'knowledge.import':object({projectId}),'knowledge.remove':expected,
 'skills.runtime':object({interpreters:z.array(projectDirectory).max(8)}),'skills.approveRun':object({id,digest:z.string().regex(/^[a-f0-9]{64}$/),approved:z.boolean()}),'components.previewLegacy':object({}),'components.migrate':object({token:id}),'components.restoreMigration':object({recoveryId:id}),
 'skills.save':object({...edit,name:text(100).min(1),description:text(1000),descriptionZh:text(20000).optional(),content:text(100000)}),'skills.previewImport':object({}),'skills.import':object({token:id.optional()}),'skills.toggle':toggle,
 'mcp.save':object({...edit,name:text(100).min(1),transport:z.enum(['stdio','http']),command:text(1000),args:z.array(text(2000)).max(50),url:text(1000),secret:text(4096).optional()}),
 'mcp.toggle':toggle,'mcp.discover':object({id}),'mcp.call':object({id,...scope,name:text(300).min(1),arguments:z.record(z.unknown())}),'mcp.readResource':object({id,...scope,uri:text(2000).min(1)}),
 'grants.save':object({...scope,mcpId:id,configVersion:z.number().int().positive(),capabilityType:z.enum(['tool','resource']),capabilityName:text(2000).min(1),readOnly:z.literal(true),allowedSchema:z.record(z.unknown())}),'grants.revoke':expected,
 'plugins.preview':object({}),'plugins.install':object({token:id}),'plugins.toggle':toggle,'plugins.uninstall':expected,
 'schedules.save':object({...edit,name:text(100).min(1),prompt:text(30000).min(1),projectId,model,context:scheduleContext,spec}),'schedules.toggle':toggle,'schedules.run':object({id,triggerId:id}),'schedules.runs':object({id}),
 'data.openDirectory':object({}),'data.backup':object({}),'data.validate':object({}),'data.restoreCopy':object({token:id})
};
