import {MessageBody,MessageActions,SentAttachments,messageRole} from './ChatMessageContent';
import { acceptRetryAttempt, chatUserResolver, mergeChatHistory, visibleChatMessages } from './chat-attempts';
import { ContextPicker,type ContextPickerController } from './ContextPicker';
import { ComposerAttachments,useComposerAttachments } from './ComposerAttachments';
import { useComposerSuggestions } from './ComposerSuggestions';
import type { ComposerCommand } from './composer-commands';
import type {ContextOwner} from '../shared/chat-context';
import { taskCalendarDate } from '../shared/dates';
import { ActionIcon, Button, Checkbox, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { Icon } from './icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { emptyContext, nativeToolHistory, type ComponentSession, type ContextSelection, type Draft, type TaskDraft, type FileDraft, type Message, type ModelRef, type TaskAction } from '../shared/types';
import { Hint, Field, Modal, ModelPicker, ProjectPicker, useAction, useApp } from './ui';
import { ComponentDraftPreview } from './ComponentDraftPreview';
import { ComponentMaterials } from './ComponentMaterials';
const inputDrafts = new Map<string, string>();
export function prepareChatInput(conversationId: string, text: string) { inputDrafts.set(conversationId, text); }
const pendingContexts = new Map<string, ContextSelection>();
const pendingModels = new Map<string, ModelRef | null>();
const draftOwners=new Map<string,string>();
function draftKey(key:string){if(!draftOwners.has(key))draftOwners.set(key,crypto.randomUUID());return draftOwners.get(key)!;}
function messageModel(snapshot: unknown, sources: {
  id: string;
  name: string;
}[]) {
  if (!snapshot || typeof snapshot !== 'object')
    return '';
  const s = snapshot as {
    model?: ModelRef;
    source?: {
      name?: string;
    };
    sourceName?: string;
  };
  return s.model ? `${s.model.modelId} · ${s.sourceName ?? s.source?.name ?? sources.find(source => source.id === s.model?.sourceId)?.name ?? '模型源已移除'}` : '';
}
function MediaPreview({message}:{message:Message}) {const {call,report}=useApp();const [urls,setUrls]=useState<Record<string,string>>({});const [error,setError]=useState('');useEffect(()=>{let active=true;void Promise.all((message.media??[]).map(async media=>{const result=await call('media.read',{messageId:message.id,artifactId:media.id});if(active)setUrls(old=>({...old,[media.id]:result.dataUrl}));})).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;};},[message.id,message.media,call]);return <div className="message-media">{(message.media??[]).map(media=><figure key={media.id}><figcaption>{media.frameCount===24?'24 帧 GIF · 10 fps':'AI 生成'+(message.media!.length>1?'帧表':'图片')} · {media.width}×{media.height}</figcaption>{urls[media.id]?<img src={urls[media.id]} alt={media.frameCount===24?'AI 生成的 24 帧循环动图':'AI 生成图片或帧表'}/>:<span>正在读取本地图片…</span>}<div className="actions"><Button variant="subtle" size="compact-sm" onClick={()=>void call('media.open',{messageId:message.id,artifactId:media.id}).catch(e=>report(e.message))}>打开文件</Button><Button variant="subtle" size="compact-sm" onClick={()=>void call('media.open',{messageId:message.id,artifactId:media.id,directory:true}).catch(e=>report(e.message))}>打开所在目录</Button></div></figure>)}{error&&<p className="notice">{error}</p>}</div>;}
function actionText(a: TaskAction) {
  if (a.type === 'create')
    return `新增 · ${a.title} · ${a.date}`;
  if (a.type === 'update')
    return `修改 · ${a.title ?? a.taskId} · v${a.expectedVersion}`;
  if (a.type === 'complete')
    return `${a.completed ? '完成' : '恢复未完成'} · ${a.taskId} · v${a.expectedVersion}`;
  return `改期 · ${a.taskId} → ${a.date} · v${a.expectedVersion}`;
}
function TaskDraftPreview({ draft, readOnly }: {
  draft: TaskDraft;
  readOnly: boolean;
}) {
  const { call, report } = useApp();
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(JSON.stringify(draft.actions, null, 2));
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => {
    setJson(JSON.stringify(draft.actions, null, 2));
    setConfirm(false);
  }, [draft.version]);
  return <div className="draft-card">
    <div className="section-heading">
      <h4>
        待办草案 ·
        {draft.actions.length}
        项
      </h4>
      <span className="tag">
        {draft.status === 'applied' ? '已应用' : draft.status === 'discarded' ? '已放弃' : draft.status === 'needsConfirmation' ? '待重新确认' : '待确认'}
      </span>
    </div>
    {draft.actions.map((a, i) => <p key={i}>
      {i + 1}
      .
      {actionText(a)}
    </p>)}
    {!readOnly && (draft.status === 'pending' || draft.status === 'needsConfirmation') && <><div className="actions">
      <Button type="button" onClick={() => setEditing(true)} disabled={busy}>
        编辑 / 验证 JSON
      </Button>
      <Button type="button" className="primary" disabled={busy || draft.status === 'needsConfirmation'} onClick={() => void run(async () => {
        await call('drafts.apply', { id: draft.id, expectedVersion: draft.version });
        report('草案已应用到月历。');
      })}>
        应用到月历
      </Button>
      <Button type="button" disabled={busy} onClick={() => void run(async () => {
        await call('drafts.discard', { id: draft.id, expectedVersion: draft.version });
      })}>
        放弃
      </Button>
    </div>{draft.status === 'needsConfirmation' && <p className="notice">
      聊天已移动。请编辑项目归属并重新验证草案，确认后才可应用。
    </p>}</>}
    {editing && !readOnly && <Modal title="编辑并重新验证任务草案" wide onClose={() => setEditing(false)} submit="验证并保存" onSubmit={async () => {
      const actions: unknown = JSON.parse(json);
      if (!Array.isArray(actions))
        throw new Error('JSON 顶层必须是 actions 数组。');
      await call('drafts.save', { id: draft.id, expectedVersion: draft.version, actions: actions as TaskAction[], ...(draft.status === 'needsConfirmation' ? { confirmProject: confirm } : {}) });
    }}>
      <p className="muted">
        四种操作：create / update / complete / reschedule。新增和改期使用 date，已有任务使用 taskId 与 expectedVersion。所有字段与任务范围会由主进程重新校验。
      </p>
      <Field label="actions JSON 数组">
        <Textarea className="code" rows={15} value={json} onChange={e => setJson(e.target.value)} spellCheck={false} />
      </Field>
      {draft.status === 'needsConfirmation' && <Checkbox className="check" required checked={confirm} onChange={e => setConfirm(e.target.checked)} label="我已检查草案的项目归属与当前任务范围" />}
    </Modal>}
  </div>;
}
function DraftPreview({draft,readOnly,running,componentReady}:{draft:Draft;readOnly:boolean;running:boolean;componentReady:boolean}){return draft.kind==='component'?<ComponentDraftPreview draft={draft} readOnly={readOnly||!componentReady} running={running}/>:draft.kind==='file'?<FileDraftPreview draft={draft} readOnly={readOnly}/>:<TaskDraftPreview draft={draft} readOnly={readOnly}/>;}
function FileDraftPreview({draft,readOnly}:{draft:FileDraft;readOnly:boolean}){
 const {call,report}=useApp(),{busy,run}=useAction();
 return <div className="draft-card" aria-label="文件修改提案"><div className="section-heading"><h4>文件修改 · {draft.file.path}</h4><span className="tag">{draft.status==='applied'?'已应用':draft.status==='discarded'?'已放弃':draft.status==='unavailable'?'不可应用':draft.status==='applying'?'应用待核对':'待确认'}</span></div>
 <div className="file-draft-preview"><details open><summary>{draft.file.before===null?'原文件（新建）':'原文'}</summary><pre>{draft.file.before??'文件尚不存在'}</pre></details><details open><summary>新文</summary><pre>{draft.file.after}</pre></details></div>
 {draft.error&&<p className="notice">{draft.error}</p>}
 {!readOnly&&(draft.status==='pending'||draft.status==='applying')&&<div className="actions"><Button type="button" className="primary" disabled={busy} onClick={()=>void run(async()=>{await call('drafts.apply',{id:draft.id,expectedVersion:draft.version});report('文件修改已应用到项目文件夹。');})}>{draft.status==='applying'?'核对并重试':'应用到文件夹'}</Button><Button type="button" disabled={busy} onClick={()=>void run(()=>call('drafts.discard',{id:draft.id,expectedVersion:draft.version}))}>放弃</Button></div>}
 </div>;
}
export function Chat({ conversationId, newProjectId = null, date, newDate, onProjectChange }: {
  conversationId: string | null;
  newProjectId?: string | null;
  date: string | null;
  newDate?: string | null;
  onProjectChange?: (id: string | null) => void;
}) {
  const { state, call, report, go, openChat } = useApp();
  const conversation = state.conversations.find(c => c.id === conversationId);
  const pendingKey = conversationId ?? `${onProjectChange ? 'home' : 'new'}:${newProjectId ?? 'none'}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const visibleMessages = visibleChatMessages(messages);
  const userForMessage = chatUserResolver(messages);
  const [input, setInput] = useState('');
  const [model, setModel] = useState<ModelRef | null>(pendingModels.has(pendingKey) ? pendingModels.get(pendingKey)! : conversation?.model ?? state.defaultModel);
  const [contextValue, setContext] = useState<ContextSelection>(() => pendingContexts.get(pendingKey) ?? conversation?.context ?? { ...emptyContext(), date });
  const homeDate = !conversationId && onProjectChange ? date : null;
  function bindCalendarContext(value: ContextSelection): ContextSelection {
    return homeDate ? { ...value, date: homeDate, calendarTasks: true, taskIds: value.taskIds.filter(id => state.tasks.some(task => task.id === id && !task.deletedAt && taskCalendarDate(task) === homeDate && task.projectId === newProjectId)) } : value;
  }
  const context = bindCalendarContext(contextValue);
  const owner:ContextOwner={projectId:conversation?conversation.projectId:newProjectId,conversationId,draftKey:draftKey(pendingKey)};
  const [uploading,setUploading]=useState(false);
  const uploadLock=useRef(false);const uploadBusy=useCallback((value:boolean)=>{uploadLock.current=value;setUploading(value);},[]);
  const [materialBusy,setMaterialBusy]=useState(false);
  const materialLock=useRef(false);const materialsBusy=useCallback((value:boolean)=>{materialLock.current=value;setMaterialBusy(value);},[]);
  const [componentSession,setComponentSession]=useState<ComponentSession|null>(null);
  const [componentSessionLoaded,setComponentSessionLoaded]=useState(false);
  const [modelOpenRequest,setModelOpenRequest]=useState(0);
  const inputRef=useRef<HTMLTextAreaElement>(null),composerRef=useRef<HTMLDivElement>(null);
  const contextPickerRef=useRef<ContextPickerController>(null);
  const commandScope=JSON.stringify([owner,date,newDate]);
  const commandRuntime=useRef({scope:commandScope,alive:true,revision:0});
  if(commandRuntime.current.scope!==commandScope){commandRuntime.current.scope=commandScope;commandRuntime.current.revision++;}
  useEffect(()=>{commandRuntime.current.alive=true;return()=>{commandRuntime.current.alive=false;};},[]);
  function changeInput(text:string){setInput(text);inputDrafts.set(pendingKey,text);}
  const [toolAsText, setToolAsText] = useState(false);
  const [localRequest, setLocalRequest] = useState<string | null>(null);
  const { busy, run } = useAction();
  const scroll = useRef<HTMLDivElement>(null);
  const jumpRail = useRef<HTMLElement>(null);
  const followLatest = useRef(true);
  const [activeMessage, setActiveMessage] = useState<string | null>(null);
  const currentId = useRef(conversationId);
  const revision = useRef(0);
  const contextOwner = useRef({ id: conversationId, projectId: conversation?.projectId });
  currentId.current = conversationId;
  const sessionCall=useRef(call);sessionCall.current=call;
  const sessionRevision=useRef(0);
  const refreshComponentSession=useCallback(async()=>{
    const id=currentId.current;
    if(!id)return;
    const sequence=++sessionRevision.current;
    try {
      const result=await sessionCall.current('components.session',{conversationId:id});
      if(currentId.current===id&&sessionRevision.current===sequence){setComponentSession(result);setComponentSessionLoaded(true);}
    } catch(error) {
      if(currentId.current===id&&sessionRevision.current===sequence)throw error;
    }
  },[]);
  function chooseContext(next: ContextSelection) {
    if(conversation?.componentMode&&(next.skillRef||next.mcpRefs.length||next.pluginRefs?.length)){report('管理对话不能混合普通组件，请新建普通聊天。');return;}
    const selected = bindCalendarContext(next);
    pendingContexts.set(pendingKey, selected); setContext(selected);

  }
  useEffect(()=>{
    sessionRevision.current++;
    setComponentSession(null);setComponentSessionLoaded(false);
  },[conversationId]);
  useEffect(()=>{
    if(!conversationId)return;
    void refreshComponentSession().catch(error=>{if(currentId.current===conversationId){setComponentSessionLoaded(true);report(error.message);}});
  },[conversationId,conversation?.version,conversation?.activeRequestId,refreshComponentSession]);
  async function history(id: string) {
    const sequence = revision.current;
    const result = await call('conversations.history', { id });
    if (currentId.current !== id)
      return;
    setMessages(current => {
      if (sequence === revision.current)
        return result;
      return mergeChatHistory(result, current);
    });
  }
  useEffect(() => {
    revision.current++;
    followLatest.current = true;
    setActiveMessage(null);
    setMessages([]);
    setInput(inputDrafts.get(pendingKey) ?? '');
    setLocalRequest(conversation?.activeRequestId ?? null);
    setModel(pendingModels.has(pendingKey) ? pendingModels.get(pendingKey)! : conversation?.model ?? state.defaultModel);
    setContext(pendingContexts.get(pendingKey) ?? conversation?.context ?? { ...emptyContext(), date:newDate ?? date });
    setToolAsText(false);
    if (conversationId)
      void history(conversationId).catch(e => report(e.message));
  }, [conversationId]);
  useEffect(() => {
    if (conversationId || newDate === undefined) return;
    setInput(inputDrafts.get(pendingKey) ?? '');
    setModel(pendingModels.has(pendingKey) ? pendingModels.get(pendingKey)! : state.defaultModel);
    chooseContext(pendingContexts.get(pendingKey) ?? {...emptyContext(),date:newDate});
  }, [pendingKey,newDate]);
  useEffect(() => {
    if (conversation && contextOwner.current.id === conversationId && contextOwner.current.projectId !== conversation.projectId) {
      const previous=pendingContexts.get(conversation.id);if(previous?.attachmentRefs?.length)void call('context.attachments.remove',{owner:{projectId:contextOwner.current.projectId??null,conversationId:conversation.id,draftKey:draftKey(conversation.id)},tokens:previous.attachmentRefs.map(a=>a.token)}).catch(e=>report(e.message));
      pendingContexts.delete(conversation.id);
      setContext(conversation.context);
    }
    contextOwner.current = { id: conversationId, projectId: conversation?.projectId };
  }, [conversation?.projectId, conversationId]);
  useEffect(() => {
    if (localRequest && messages.some(message => message.requestId === localRequest && message.role === 'assistant' && message.status !== 'running') && !conversation?.activeRequestId)
      setLocalRequest(null);
  }, [messages, conversation?.activeRequestId]);
  useEffect(() => {
    if (!conversationId && !pendingModels.has(pendingKey) && !model && state.defaultModel)
      setModel(state.defaultModel);
  }, [state.defaultModel]);
  useEffect(() => {
    if (!conversationId)
      return;
    return window.workday.subscribe(event => {
      if (event.type === 'stateChanged' || event.conversationId !== conversationId)
        return;
      if (event.type === 'chatStarted') {
        if(event.userMessageId&&event.continuationPrefix!==undefined){revision.current++;setMessages(previous=>acceptRetryAttempt(previous,conversationId,{requestId:event.requestId,userMessageId:event.userMessageId!,continuationPrefix:event.continuationPrefix},new Date().toISOString()));}
        setLocalRequest(event.requestId);
        return;
      }
      if (event.type === 'chatDelta') {
        revision.current++;
        setMessages(previous => {
          const index = previous.findIndex(m => m.requestId === event.requestId && m.role === 'assistant' && m.status === 'running');
          if (index >= 0)
            return previous.map((m, i) => i === index ? { ...m, content: m.content + (event.text ?? '') } : m);
          return [...previous, { id: `stream-${event.requestId}`, conversationId, requestId: event.requestId, role: 'assistant', content: event.text ?? '', status: 'running', createdAt: new Date().toISOString() }];
        });
      }
      if (event.type === 'chatTool' && event.tool) {
        const tool = event.tool;
        setMessages(previous => {
          const index = previous.findIndex(m => m.requestId === event.requestId && m.role === 'assistant' && m.status === 'running');
          if (index >= 0)
            return previous.map((m, i) => i === index ? { ...m, toolCalls: [...(m.toolCalls ?? []).filter(t => t.id !== tool.id), tool] } : m);
          return [...previous, { id: `stream-${event.requestId}`, conversationId, requestId: event.requestId, role: 'assistant', content: '', status: 'running', createdAt: new Date().toISOString(), toolCalls: [tool] }];
        });
      }
      if (['chatDone', 'chatFailed', 'chatCancelled'].includes(event.type)) {
        setLocalRequest(current=>current===event.requestId?null:current);
        revision.current++;
        void history(conversationId).catch(e => report(e.message));
        if (event.type === 'chatFailed')
          report(event.message ?? '回复失败，可以重试。');
      }
    });
  }, [conversationId]);
  function trackScroll() {
    const container = scroll.current;
    if (!container) return;
    followLatest.current = container.scrollHeight - container.scrollTop - container.clientHeight < 32;
    const turns = Array.from(container.querySelectorAll<HTMLElement>('.message.user'));
    let active = turns[0];
    for (const turn of turns) {
      if (!followLatest.current && turn.getBoundingClientRect().top > container.getBoundingClientRect().top + 32) break;
      active = turn;
    }
    setActiveMessage(active?.dataset.messageId ?? null);
  }
  function jumpToMessage(id: string) {
    const container = scroll.current, target = document.getElementById(`message-${id}`);
    if (!container || !target || !container.contains(target)) return;
    followLatest.current = false;
    container.scrollTo({ top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12 });
    target.focus({ preventScroll: true });
    setActiveMessage(id);
  }
  useLayoutEffect(() => {
    if (followLatest.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      trackScroll();
    }
  }, [messages]);
  useLayoutEffect(() => {
    const rail = jumpRail.current, active = rail?.querySelector<HTMLElement>('[aria-current]');
    if (rail && active) rail.scrollTop = active.offsetTop - (rail.clientHeight - active.offsetHeight) / 2;
  }, [activeMessage]);
  const running = localRequest ?? conversation?.activeRequestId ?? null;
  const source = state.sources.find(s => s.id === model?.sourceId);
  const selectedModel = source?.models.find(m => m.id === model?.modelId);
  const validModel = !!source?.enabled && !!selectedModel;
  const toolHistory = messages.some(nativeToolHistory);
  const requiresToolText = toolHistory && !selectedModel?.supportsTools;
  const selectedSkill=state.skills.find(s=>s.id===context.skillRef?.id);
  const managerSelected=!!conversation?.componentMode;
  const needsSkillTools=(!!selectedSkill?.installation||managerSelected)&&!selectedModel?.supportsTools;
  const managerChat=managerSelected||!!componentSession;
  const componentReady=!!componentSession?.active&&componentSession.conversationId===conversationId&&managerSelected&&!context.skillRef&&!context.mcpRefs.length&&!context.pluginRefs?.length;
  const projectId = conversation ? conversation.projectId : newProjectId;
  const drafts = state.drafts.filter(d => d.conversationId === conversationId);
  const calendarTaskCount = context.calendarTasks ? state.tasks.filter(task => !task.deletedAt && taskCalendarDate(task) === context.date).length : 0;
  const calendarHint = `${context.date} · 自动携带当天全部 ${calendarTaskCount} 项待办（含已完成及其他项目），作为只读参考。`;
  const turns = messages.filter(m => m.role === 'user' && m.conversationId === conversationId);
  const latestUser=messages.filter(m=>m.role==='user'&&m.conversationId===conversationId).at(-1);
  function retryDisabledReason(message:Message){
    if(conversation?.archived)return '聊天已归档，请先恢复';
    if(busy||running)return '正在处理请求，请稍后重试';
    if((message.status==='complete'||(message.snapshot as any)?.replacesMessageId)&&userForMessage(message)?.id!==latestUser?.id)return '仅支持重新生成最新一轮';
  }
  function canRetryMessage(message:Message){
    const original=userForMessage(message),snapshot=(message.snapshot??original?.snapshot) as {componentMode?:boolean;context?:ContextSelection}|undefined;
    return !!original&&!snapshot?.componentMode&&!/^b17d0000-0000-4000-8000-00000000000[123]$/.test(snapshot?.context?.skillRef?.id??'');
  }
  function retryMessage(message:Message,continuing=false){
    if(!canRetryMessage(message)||retryDisabledReason(message))return;
    void run(async()=>{
      const original=userForMessage(message);
      if(!original)throw new Error('找不到原始用户消息，请刷新历史。');
      const retry=continuing?await call('chat.continue',{conversationId:message.conversationId,requestId:message.requestId}):await call('chat.retry',{conversationId:message.conversationId,userMessageId:original.id});
      if(currentId.current!==message.conversationId)return;
      revision.current++;
      setMessages(previous=>acceptRetryAttempt(previous,message.conversationId,retry,new Date().toISOString()));
      setLocalRequest(retry.requestId);
      await history(message.conversationId);
    });
  }
  const commandsDisabled=busy||uploading||materialBusy||!!running||!!conversation?.archived;
  const commandAvailability=useRef(commandsDisabled);commandAvailability.current=commandsDisabled;
  function executeCommand(command:ComposerCommand){
    if(commandAvailability.current||uploadLock.current||materialLock.current)return;
    if(command==='attach'){contextPickerRef.current?.upload();return;}
    if(command==='skill'||command==='plugin'){contextPickerRef.current?.open(command==='skill'?'skills':'plugins');return;}
    if(command==='model'){
      if(!state.sources.some(source=>source.enabled&&source.models.length))go('设置','models');
      else setModelOpenRequest(value=>value+1);
      return;
    }
    const origin=commandScope,revision=commandRuntime.current.revision;
    void run(async()=>{
      const created=await call('conversations.create',{projectId,date:null,model});
      if(commandRuntime.current.alive&&commandRuntime.current.scope===origin&&commandRuntime.current.revision===revision)openChat(created.id,created.projectId);
    });
  }
  const attachments=useComposerAttachments({owner,scope:commandScope,value:context,onChange:chooseContext,onBusyChange:uploadBusy,disabled:busy||materialBusy||!!running||!!conversation?.archived});
  const suggestions=useComposerSuggestions({input,onInput:changeInput,inputRef,anchorRef:composerRef,owner,scope:commandScope,disabled:commandsDisabled,management:managerChat,context,onContext:chooseContext,onCommand:executeCommand,onPlugin:id=>contextPickerRef.current?.open('plugins',id)});
  async function send() {
    if (uploadLock.current || materialLock.current || conversation?.archived || needsSkillTools || (managerChat&&!componentReady) || (!input.trim()&&!context.attachmentRefs?.length) || !model || !validModel || running)
      return;
    let id = conversationId;
    let createdVersion: number | undefined;
    if (!id) {
      const created = await call('conversations.create', { projectId: newProjectId, date: context.date, model });
      id = created.id;
      createdVersion = created.version;
      draftOwners.set(id,owner.draftKey);
      pendingContexts.set(id, context);
      inputDrafts.set(id, input);
    }
    let sent;
    try {
      if(createdVersion!==undefined&&context.attachmentRefs?.length)await call('context.attachments.transfer',{owner,conversationId:id,tokens:context.attachmentRefs.map(a=>a.token)});
      if (homeDate && createdVersion !== undefined)
        await call('conversations.context', { id, expectedVersion: createdVersion, context });
      sent = await call('chat.send', { conversationId: id, text: input, model, context, owner:{...owner,conversationId:id}, ...(requiresToolText ? { toolHistoryAsText: toolAsText } : {}) });
    } catch (error) {
      if (!conversationId) {
        inputDrafts.delete(pendingKey);
        pendingContexts.delete(pendingKey);draftOwners.delete(pendingKey);
        openChat(id, newProjectId);
      }
      throw error;
    }
    const sentContext={...context,attachmentRefs:[]};pendingContexts.set(id,sentContext);
    inputDrafts.set(id, '');
    if (!conversationId)
      inputDrafts.set(pendingKey, '');
    if (!conversationId) {
      pendingContexts.delete(pendingKey);draftOwners.delete(pendingKey);
      openChat(id, newProjectId);
      return;
    }
    if (currentId.current === id) {
      followLatest.current = true;
      setInput('');setContext(sentContext);
      setLocalRequest(sent.requestId);
    }
    void history(id).catch(e => report(e.message));
  }
  return <section className={`chat ${onProjectChange ? 'new-chat' : 'panel'}`} aria-label={onProjectChange ? '新聊天' : '聊天'}>
    {!onProjectChange && <div className="chat-transcript">
      {turns.length > 1 && <nav className="chat-jump" ref={jumpRail} aria-label="对话快速跳转">
        {turns.map((turn, index) => {
          const reply = visibleMessages.filter(m => m.role === 'assistant' && userForMessage(m)?.id === turn.id).at(-1);
          return <Tooltip key={turn.id} classNames={{ tooltip: 'chat-jump-tooltip' }} position="right" offset={8} openDelay={150} events={{ hover: true, focus: true, touch: false }} label={<div className="chat-jump-preview">
            <strong>{turn.content.slice(0, 300)}</strong>
            <span>{reply?.content.slice(0, 500) || (reply?.status === 'running' ? '正在生成…' : '暂无回复')}</span>
          </div>}>
            <UnstyledButton type="button" className="chat-jump-mark" aria-label={`跳转到第 ${index + 1} 轮：${turn.content.slice(0, 80)}`} aria-current={activeMessage === turn.id ? 'location' : undefined} onClick={() => jumpToMessage(turn.id)}><span /></UnstyledButton>
          </Tooltip>;
        })}
      </nav>}
      <div className="messages" ref={scroll} onScroll={trackScroll} role="log" aria-label="对话记录" aria-live="polite">
      {visibleMessages.map(m => <article className={`message ${m.role}`} id={`message-${m.id}`} data-message-id={m.id} tabIndex={-1} key={m.id} aria-label={messageRole(m)}>
        <div className="message-group">
        {m.role==='user'&&<SentAttachments message={m}/>}
        {!(m.role==='tool'&&!nativeToolHistory(m))&&<MessageBody message={m}/>}
        {!!m.media?.length&&<MediaPreview message={m}/>}
        {m.toolCalls?.map(t => <details className="tool-result" key={t.id}>
          <summary>
            {t.kind === 'project' ? '项目查询 · ' : '工具 · '}
            {t.capabilityName ?? t.name}
            ·
            {t.status ?? '已提交'}
          </summary>
          <pre>
            {t.result ?? t.arguments}
          </pre>
        </details>)}

        {m.status !== 'complete' && <div className={`message-status ${m.status}`}>
          <span>
            {m.status === 'running' ? '正在生成…' : m.status === 'failed' ? '失败 · 未加入后续上下文' : m.status === 'cancelled' ? '已停止' : ''}
          </span>
          {m.error && <p>
            {m.error}
          </p>}
          {!conversation?.archived&&m.status==='cancelled'&&m.continuable&&userForMessage(m)?.id===latestUser?.id&&<Button size="compact-sm" variant="subtle" type="button" disabled={busy||!!running} onClick={()=>retryMessage(m,true)}>继续生成</Button>}
        </div>}
        {m.role!=='user'&&<MessageActions message={m} model={messageModel(m.snapshot ?? userForMessage(m)?.snapshot,state.sources)} retry={m.role==='assistant'&&(m.status==='complete'||(!conversation?.archived&&['failed','cancelled'].includes(m.status)))&&canRetryMessage(m)?{onRetry:()=>retryMessage(m),label:m.status!=='complete'?'重试此轮':m.imageJobId?'重新处理图片（复用已有源图）':'重新生成',disabledReason:retryDisabledReason(m)}:undefined}/>}
        </div>
      </article>)}
      {(state.pendingSkillRuns??[]).filter(p=>p.conversationId===conversationId).map(p=><div className="draft-card" aria-label="脚本运行确认" key={p.id}><h4>{p.skillName} · 单次运行</h4><pre>{JSON.stringify({script:p.path,args:p.args,interpreter:p.interpreter,cwd:p.projectRoot??p.outputDirectory,output:p.outputDirectory},null,2)}</pre><p className="notice">单进程，禁止创建子进程与访问网络。项目和已安装包只读，仅本次输出目录可写。需要子命令的脚本暂不支持此运行方式。</p><div className="actions"><Button type="button" className="primary" onClick={()=>void call('skills.approveRun',{id:p.id,digest:p.digest,approved:true}).catch(e=>report(e.message))}>运行一次</Button><Button type="button" onClick={()=>void call('skills.approveRun',{id:p.id,digest:p.digest,approved:false}).catch(e=>report(e.message))}>拒绝</Button></div></div>)}
      {drafts.map(d => <DraftPreview key={d.id} draft={d} readOnly={!!conversation?.archived} running={!!running} componentReady={componentReady} />)}
      </div>
    </div>}
    {conversation?.archived ? <div className="notice archived-chat-notice">
      <span>此聊天已归档，历史消息已保留。</span>
      <Button type="button" disabled={busy} onClick={() => void run(async () => {
        await call('conversations.archive', {id: conversation.id, expectedVersion: conversation.version, archived: false});
      })}>恢复聊天</Button>
    </div> : <div className="composer">
      {onProjectChange && <div className="composer-project">
        <Icon name="folder" size="folder" />
        <ProjectPicker width="content" disabled={busy||uploading} value={newProjectId} onChange={id => {
          if (busy||uploading) return;
          const nextKey = `home:${id ?? 'none'}`;
          if(context.attachmentRefs?.length)void call('context.attachments.remove',{owner,tokens:context.attachmentRefs.map(a=>a.token)}).catch(e=>report(e.message));
          const nextPending=pendingContexts.get(nextKey);if(nextPending?.attachmentRefs?.length)void call('context.attachments.remove',{owner:{projectId:id,conversationId:null,draftKey:draftKey(nextKey)},tokens:nextPending.attachmentRefs.map(a=>a.token)}).catch(e=>report(e.message));
          draftOwners.delete(pendingKey);draftOwners.delete(nextKey);
          inputDrafts.delete(pendingKey);
          inputDrafts.set(nextKey, input);
          pendingModels.set(nextKey, model);
          pendingContexts.delete(pendingKey);
          pendingContexts.delete(nextKey);
          setContext(emptyContext());
          onProjectChange(id);
        }} />
        {homeDate && <Hint label={calendarHint}><span className="composer-calendar" tabIndex={0} aria-label={calendarHint}>
          <Icon name="calendar-clock" size="sm" />
          {homeDate.slice(5).replace('-', '/')} · {calendarTaskCount} 项待办
        </span></Hint>}
      </div>}
      {!validModel && !onProjectChange && <div className="composer-model-hint">
        <span>选择模型后即可开始对话</span>
        <UnstyledButton type="button" className="composer-model-action" onClick={() => go('设置')}>
          配置模型源<Icon name="arrow-right" size="sm" />
        </UnstyledButton>
      </div>}
      {conversation?.platformContextNotice&&!managerChat&&<p className="notice">{conversation.platformContextNotice}</p>}
      {needsSkillTools&&<p className="notice">{managerSelected?'创建和导入需要支持工具的模型。请选择支持工具的模型后继续。':'所选 Skill 需要支持工具的模型。请先在模型源确认能力，或切换模型。'}</p>}
      {requiresToolText && <div className="notice">
        此模型不支持工具调用。
        <Checkbox className="check" checked={toolAsText} onChange={e => setToolAsText(e.target.checked)} label="将已完成的工具结果作为明确标注的参考文本继续" />
        <Button type="button" disabled={busy} onClick={() => void run(async () => {
          const c = await call('conversations.create', { projectId, date: null, model });
          openChat(c.id, c.projectId);
        })}>
          新建文本聊天
        </Button>
      </div>}
      {!selectedModel?.supportsTools && context.mcpRefs.length > 0 && <p className="notice">
        此模型不支持工具调用，请清除所选 MCP 工具后发送。
      </p>}
      {conversationId&&managerChat&&(componentSessionLoaded?<ComponentMaterials key={conversationId} session={componentReady?componentSession:componentSession?{...componentSession,active:false}:null} conversationId={conversationId} disabled={busy||uploading||!!running} onBusyChange={materialsBusy} onChange={refreshComponentSession}/>:<p className="muted" role="status">正在准备对话…</p>)}
      <div className="composer-input" ref={composerRef}>
        <ComposerAttachments attachments={context.attachmentRefs??[]} previews={attachments.previews} preparing={attachments.preparing} error={attachments.error} disabled={busy||materialBusy||!!running||!!conversation?.archived} onRemove={attachments.remove}/>
        <Textarea ref={inputRef} data-composer-paste aria-label="消息输入" {...suggestions.aria} disabled={busy} autosize minRows={2} maxRows={8} placeholder={onProjectChange ? '随心输入，@ 添加上下文，/ 快捷命令' : '和 AI 一起安排工作… @ 上下文 / 命令'} value={input}
          onPaste={e=>{attachments.paste(e,(text,start,end)=>{const field=e.currentTarget,next=field.value.slice(0,start)+text+field.value.slice(end);changeInput(next);requestAnimationFrame(()=>{if(inputRef.current===field&&field.value===next)field.setSelectionRange(start+text.length,start+text.length);});});}}
          onChange={e=>{changeInput(e.currentTarget.value);suggestions.detect(e.currentTarget);}}
          onClick={e=>suggestions.detect(e.currentTarget)}
          onSelect={e=>suggestions.onSelect(e.currentTarget)}
          onBlur={suggestions.close}
          onKeyUp={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))suggestions.detect(e.currentTarget);}}
          onCompositionStart={suggestions.onCompositionStart}
          onCompositionEnd={e=>suggestions.onCompositionEnd(e.currentTarget)}
          onKeyDown={e=>{
            if(suggestions.onKeyDown(e))return;
            if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){
              e.preventDefault();suggestions.close();
              if(!busy&&!uploadLock.current&&!materialLock.current&&!needsSkillTools&&!(requiresToolText&&!toolAsText))void run(send);
            }
          }}/>
        {suggestions.menu}
        <div className="composer-footer">
          <ContextPicker management={managerChat} controllerRef={contextPickerRef} scopeKey={commandScope} value={context} onChange={chooseContext} owner={owner} disabled={busy||uploading||materialBusy||!!running} onUpload={attachments.upload}/>
          {onProjectChange && !state.sources.some(s => s.enabled && s.models.length) ? <UnstyledButton type="button" className="configure-model" onClick={() => go('设置')}>配置模型源</UnstyledButton> : <ModelPicker openRequest={modelOpenRequest} width="content" value={model} onChange={next => { setModel(next); pendingModels.set(pendingKey, next); }} disabled={busy} />}
          {running ? <Hint label={busy?'正在停止…':'停止'}><span className="hint-target"><ActionIcon type="button" className="primary send stop" aria-label="停止" disabled={busy} onClick={() => void run(async () => {
            await call('chat.cancel', { requestId: running });
          })}>
            {busy?<Icon name="loader-circle" />:<span className="stop-square" aria-hidden="true" />}
          </ActionIcon></span></Hint> : <Hint label="发送（⌘ / Ctrl + Enter）"><span className="hint-target" tabIndex={busy || uploading || materialBusy || (managerChat&&!componentReady) || (!input.trim()&&!context.attachmentRefs?.length) || !validModel || (requiresToolText && !toolAsText) || needsSkillTools || (!selectedModel?.supportsTools && context.mcpRefs.length > 0) ? 0 : undefined}><ActionIcon type="button" className="primary send" aria-label="发送消息" disabled={busy || uploading || materialBusy || (managerChat&&!componentReady) || (!input.trim()&&!context.attachmentRefs?.length) || !validModel || (requiresToolText && !toolAsText) || needsSkillTools || (!selectedModel?.supportsTools && context.mcpRefs.length > 0)} onClick={() => void run(send)}>
            <Icon name={busy ? 'loader-circle' : 'arrow-up'} />
          </ActionIcon></span></Hint>}
        </div>
      </div>
    </div>}

  </section>;
}
