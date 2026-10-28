export type Id = string;
export interface WeatherLocation {name:string;country:string;region?:string;latitude:number;longitude:number;timezone:string}
export type WeatherPreference={mode:'auto'}|{mode:'manual';location:WeatherLocation};
export interface WeatherDay {date:string;code:number;temperatureMin:number;temperatureMax:number}
export interface WeatherResult {status:'ready'|'unavailable';location:WeatherLocation|null;day:WeatherDay|null;message:string|null}
export interface HolidayMark {date:string;name:string;kind:'rest'|'work'}
export interface HolidayYear {year:number;sourceUrl:string;sourceTitle:string;queriedAt:string;days:HolidayMark[]}
export interface HolidayResult {year:number;data:HolidayYear|null;status:'cached'|'updated'|'not-found'|'error';message:string|null}
export interface MeetingsQuery {startDate:string;endDate:string;timezone:string;requestAccess?:boolean}
export interface Meeting {id:string;title:string;start:string;end:string;allDay:boolean;startDate:string|null;endDate:string|null}
export interface MeetingsResult {startDate:string;endDate:string;timezone:string;status:'ready'|'notDetermined'|'denied'|'restricted'|'notFound'|'ambiguous'|'unsupported'|'error';meetings:Meeting[];message:string|null}
export interface KeychainResult {status:'unsupported'|'unsupportedPackage'|'notFound'|'notListed'|'listed'|'locked'|'needsManual'|'cancelled'|'error'|'unverified'|'updated'|'unknown'|'busy';signing:'adhoc'|'signed'|'unknown';canConfigure:boolean;message:string}
export type ModelRef = {sourceId:Id; modelId:string};
export type VersionRef = {id:Id;version:number};
export interface PluginRef extends VersionRef {skillId:string|null;mcpRefs:{id:Id;configVersion:number;capabilityNames:string[]}[]}
export interface ContextSelection {date:string|null;calendarTasks?:boolean;taskIds:Id[];knowledgeRefs:(VersionRef & {excerpt?:string})[];skillRef:VersionRef|null;mcpRefs:{id:Id;configVersion:number;capabilityNames:string[]}[];attachmentRefs?:import('./chat-context').AttachmentRef[];conversationRefs?:(VersionRef & {digest:string})[];pluginRefs?:PluginRef[]}
export const emptyContext = ():ContextSelection => ({date:null,taskIds:[],knowledgeRefs:[],skillRef:null,mcpRefs:[]});
export interface Entity {id:Id;version:number;createdAt:string;updatedAt:string}
export type TaskPriority = 'P0' | 'P1' | 'P2';
export interface Task extends Entity {priority:TaskPriority;title:string;notes:string;date:string;dueDate:string|null;projectId:Id|null;completed:boolean;completedDate:string|null;deletedAt:string|null}
export interface GitAccount {provider:'github';connectionId:string;accountId:number;login:string;credentialConfigured:boolean}
export interface RepositoryRef {provider:'github';connectionId:string;repositoryId:number;owner:string;name:string;defaultBranch:string}
export interface RepoSummary extends RepositoryRef {private:boolean;description:string|null}
export interface GitPreview {token:string;repository:string;commit:string;content:string;paths:string[]}
export interface Project extends Entity {name:string;description:string;directory:string|null;repository?:RepositoryRef|null;archived:boolean}
export interface Conversation extends Entity {componentMode?:{kind:ComponentKind;intent:ComponentIntent};platformContextNotice?:string;title:string;projectId:Id|null;model:ModelRef|null;context:ContextSelection;activeRequestId:Id|null;archived:boolean}
export type MessageStatus='complete'|'running'|'failed'|'cancelled';
export interface TokenUsage {inputTokens?:number;outputTokens?:number;totalTokens?:number;cachedInputTokens?:number;cacheWriteTokens?:number}
export interface MessageMetrics {startedAt:string;completedAt?:string;durationMs?:number;interrupted?:boolean;rounds:number;completedRounds:number;usage?:TokenUsage;reportedRounds?:Partial<Record<keyof TokenUsage,number>>}
export interface MediaArtifact {id:string;jobId:string;name:'source.png'|'animation.gif';mime:'image/png'|'image/gif';bytes:number;sha256:string;width:number;height:number;frameCount:1|24;relativePath:string}
export interface Message {continuable?:boolean;id:Id;conversationId:Id;requestId:Id;role:'user'|'assistant'|'tool';content:string;status:MessageStatus;createdAt:string;replyToMessageId?:string;toolCallId?:string;toolCalls?:ToolCall[];snapshot?:unknown;error?:string;media?:MediaArtifact[];imageJobId?:string;metrics?:MessageMetrics}
export interface Model {id:string;name:string;supportsTools:boolean}
export interface Source extends Entity {name:string;configVersion:number;baseUrl:string;enabled:boolean;models:Model[];credentialConfigured:boolean;testedAt:string|null;testStatus:string|null}
export interface Knowledge extends Entity {name:string;content:string;projectId:Id|null;removed:boolean}
export interface Skill extends Entity {name:string;description:string;descriptionZh?:string;content:string;enabled:boolean;ownerPluginId:Id|null;installation?:{root:string;entry:string;treeHash:string;sourceKey?:string}}
export interface McpTool {name:string;description?:string;inputSchema:Record<string,unknown>}
export interface McpResource {uri:string;name:string;description?:string}
export interface McpPrompt {name:string;description?:string}
export interface McpServer extends Entity {name:string;transport:'stdio'|'http';command:string;args:string[];url:string;enabled:boolean;ownerPluginId:Id|null;configVersion:number;credentialConfigured:boolean;tools:McpTool[];resources:McpResource[];prompts:McpPrompt[];discoveredAt:string|null;configurationReason?:string;packageEntry?:string}
export interface Grant extends Entity {scopeType:'conversation'|'schedule';scopeId:Id;mcpId:Id;configVersion:number;capabilityType:'tool'|'resource';capabilityName:string;readOnly:true;allowedSchema:Record<string,unknown>;revoked:boolean}
export interface Plugin extends Entity {pluginKey:string;name:string;description:string;descriptionZh?:string;packageVersion:string;versionDeclared?:boolean;enabled:boolean;skillIds:Id[];mcpIds:Id[];format?:'workday'|'portable'|'legacy';declarations?:{apps:string[];hooks:boolean};fileHash?:string}
export interface SkillImportPreview {token:string;name:string;description:string;descriptionZh?:string;source:string;files:number;replaces?:string}
export interface PluginPreview {token:string;name:string;pluginKey:string;packageVersion:string;versionDeclared?:boolean;description:string;descriptionZh?:string;components:{type:'skill'|'mcp';path:string;name:string}[];source:string;replaces?:string;declarations?:{apps:string[];hooks:boolean}}
export interface SkillRunPrompt {id:string;digest:string;requestId:string;conversationId:string;skillName:string;path:string;args:string[];interpreter:string;projectRoot:string|null;outputDirectory:string}
export interface ComponentMigrationPreview {token:string;inputHash:string;skills:number;plugins:number;preserved:number;added:number;items:{name:string;kind:'skill'|'plugin';skills:number;reason:string}[];completed?:boolean}
export type TaskAction={type:'create';title:string;notes?:string;date:string;projectId:Id|null}|{type:'update';taskId:Id;expectedVersion:number;title?:string;notes?:string}|{type:'complete';taskId:Id;expectedVersion:number;completed:boolean}|{type:'reschedule';taskId:Id;expectedVersion:number;date:string};
export interface TaskDraft extends Entity {kind?:'task';conversationId:Id;messageId:Id;projectId:Id|null;taskIds:Id[];actions:TaskAction[];status:'pending'|'applied'|'discarded'|'needsConfirmation';appliedTaskIds:Id[]}
export interface ProjectFileChange {path:string;before:string|null;after:string;beforeHash:string|null;afterHash:string}
export interface FileDraft extends Entity {kind:'file';conversationId:Id;messageId:Id;projectId:Id;requestId:Id;file:ProjectFileChange;binding:{projectVersion:number;prepared:unknown}|null;status:'pending'|'applying'|'applied'|'discarded'|'unavailable';error?:string}
export type ComponentKind='skill'|'mcp'|'plugin';
export type ComponentIntent='create'|'import';
export interface ComponentMaterial {token:string;name:string;digest:string;files:{path:string;bytes:number}[]}
export interface ComponentSession {conversationId:Id;kind:ComponentKind;intent:ComponentIntent;active:boolean;reason?:string;materials:ComponentMaterial[]}
export interface ComponentDraft extends Entity {kind:'component';conversationId:Id;messageId:Id;requestId:Id;componentKind:ComponentKind;name:string;description:string;descriptionZh?:string;source:string;digest:string;files:{path:string;bytes:number;text?:string}[];components:{kind:ComponentKind;name:string;action:'create'|'update';expectedVersion?:number}[];servers?:{name:string;transport:'stdio'|'http';command:string;args:string[];url:string;configurationReason?:string}[];status:'preparing'|'pending'|'applying'|'applied'|'discarded'|'unavailable';error?:string;receipt?:{ids:Id[];installedAt:string}}
export type Draft=TaskDraft|FileDraft|ComponentDraft;
export type ScheduleSpec={kind:'once';date:string;time:string;timezone:string}|{kind:'daily';time:string;timezone:string}|{kind:'weekly';weekday:number;time:string;timezone:string}|{kind:'biweekly';startDate:string;time:string;timezone:string};
export interface Schedule extends Entity {name:string;prompt:string;projectId:Id|null;model:ModelRef;context:ContextSelection;spec:ScheduleSpec;enabled:boolean;status:'active'|'paused'|'completed'|'missed';pauseReason:string|null;nextRunAt:string|null;nextSlot:string|null;sourceVersion:number}
export interface ScheduleRun {id:Id;scheduleId:Id;triggerType:'auto'|'manual';triggerId:Id|null;scheduledFor:string|null;startedAt:string;endedAt:string|null;status:'running'|'success'|'failed'|'cancelled'|'interrupted'|'missed';conversationId:Id|null;error:string|null;model:ModelRef}
export interface ToolCall {id:string;name:string;arguments:string;kind?:'project'|'skill'|'component';mcpId?:Id;capabilityName?:string;result?:string;status?:'running'|'success'|'failed'|'unknown'}
export const nativeToolHistory=(message:Pick<Message,'role'|'toolCalls'>)=>message.toolCalls?.some(t=>t.kind!=='project'||!!t.mcpId||t.name!=='workday-project')||message.role==='tool'&&!message.toolCalls?.length;
export interface AppState {gitAccount:GitAccount|null;tasks:Task[];projects:Project[];conversations:Conversation[];sources:Source[];knowledge:Knowledge[];skills:Skill[];mcpServers:McpServer[];grants:Grant[];plugins:Plugin[];drafts:Draft[];schedules:Schedule[];runs:ScheduleRun[];defaultModel:ModelRef|null;dataDirectory:string;appVersion:string;componentMigration?:{recoveryId:string}|null;pendingSkillRuns?:SkillRunPrompt[];skillInterpreters?:string[]}
export type Result<T>={ok:true;value:T}|{ok:false;error:{code:string;message:string}};
export type AppEvent={type:'stateChanged'}|{type:'chatStarted'|'chatDelta'|'chatTool'|'chatDone'|'chatFailed'|'chatCancelled';conversationId:Id;requestId:Id;userMessageId?:Id;continuationPrefix?:string;text?:string;message?:string;tool?:ToolCall};
