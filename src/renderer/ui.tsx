import { taskCalendarDate } from '../shared/dates';
import { Button, Checkbox, Modal as MantineModal, NativeSelect, Select, TextInput, Textarea, Tooltip, type SelectProps, type TooltipProps } from '@mantine/core';
import { Icon } from './icons';
import { createContext, useContext, useEffect, cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode, type FormEvent } from 'react';
import type { Operations } from '../shared/api';
import type { AppState, ModelRef, ContextSelection } from '../shared/types';
import pluginsArt from '../../assets/illustrations/empty-states/plugins.png';
import knowledgeArt from '../../assets/illustrations/empty-states/knowledge.png';
import schedulesArt from '../../assets/illustrations/empty-states/schedules.png';
import skillsArt from '../../assets/illustrations/empty-states/skills.png';
import mcpArt from '../../assets/illustrations/empty-states/mcp.png';
import modelsArt from '../../assets/illustrations/empty-states/models.png';
import runHistoryArt from '../../assets/illustrations/empty-states/run-history.png';
import { RepositorySnapshot } from './git-links';
const emptyArt = { plugins: pluginsArt, knowledge: knowledgeArt, schedules: schedulesArt, skills: skillsArt, mcp: mcpArt, models: modelsArt, runHistory: runHistoryArt };
export type Page = 'Home' | '项目' | '定时任务' | '知识库' | '插件' | '设置';
export type Call = <K extends keyof Operations>(operation: K, input: Operations[K]['input']) => Promise<Operations[K]['output']>;
export type Runtime = {
  state: AppState;
  call: Call;
  refresh: () => Promise<void>;
  report: (text: string) => void;
  go: (page: Page, tab?: 'models' | 'weather' | 'links') => void;
  openChat: (id: string, projectId?: string | null) => void;
  browseProject: (id: string | null) => void;
};
export const RuntimeContext = createContext<Runtime | null>(null);
export function useApp() {
  const app = useContext(RuntimeContext);
  if (!app)
    throw new Error('应用尚未初始化');
  return app;
}
export function useAction(onError?: (text: string) => void) {
  const { report } = useApp();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  return {
    busy, run: async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      if (lock.current)
        return;
      lock.current = true;
      setBusy(true);
      onError?.('');
      try {
        return await work();
      }
      catch (e) {
        (onError ?? report)(e instanceof Error ? e.message : String(e));
        return undefined;
      }
      finally {
        lock.current = false;
        setBusy(false);
      }
    }
  };
}
export function stamp(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const modelValue = (m: ModelRef | null) => m ? JSON.stringify([m.sourceId, m.modelId]) : '';
export const parseModel = (value: string): ModelRef | null => {
  if (!value)
    return null;
  const [sourceId, modelId] = JSON.parse(value);
  return { sourceId, modelId };
};
type DropdownWidth = 'fill' | 'content' | number;
export function Dropdown({ width = 'fill', className, ...props }: Omit<SelectProps, 'w' | 'width'> & { width?: DropdownWidth }) {
  return <Select classNames={{ dropdown: 'dropdown-menu' }} {...props} className={`dropdown dropdown-${typeof width === 'number' ? 'fixed' : width} ${className ?? ''}`}
    w={typeof width === 'number' ? `${width}px` : undefined} />;
}
export function ModelPicker({ value, onChange, disabled = false, required = false, width = 'fill', id, 'aria-describedby': describedBy, openRequest = 0 }: {
  openRequest?: number;
  id?: string;
  'aria-describedby'?: string;
  value: ModelRef | null;
  onChange: (m: ModelRef | null) => void;
  disabled?: boolean;
  required?: boolean;
  width?: DropdownWidth;
}) {
  const { state } = useApp();
  const [dropdownOpened,setDropdownOpened]=useState(false);
  const pickerRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(openRequest&&!disabled){setDropdownOpened(true);pickerRef.current?.focus();}},[openRequest]);
  useEffect(()=>{if(disabled)setDropdownOpened(false);},[disabled]);
  const current = value && state.sources.find(s => s.id === value.sourceId);
  const missing = value && (!current?.enabled || !current.models.some(m => m.id === value.modelId));
  return <Dropdown width={width} className="model-picker" classNames={{ dropdown: 'dropdown-menu model-picker-dropdown' }}
    ref={pickerRef} dropdownOpened={dropdownOpened} onDropdownOpen={()=>setDropdownOpened(true)} onDropdownClose={()=>setDropdownOpened(false)} id={id} aria-describedby={describedBy} aria-label="选择模型与模型源"
    value={value ? modelValue(value) : null} onChange={next => onChange(parseModel(next ?? ''))}
    disabled={disabled} required={required} placeholder="选择模型" allowDeselect={false}
    checkIconPosition="right" maxDropdownHeight="var(--size-modelMenuMaxHeight)"
    comboboxProps={{ width: 'var(--size-modelMenu)', position: 'bottom-end' }}
    nothingFoundMessage="暂无可用模型"
    data={[
      ...(missing ? [{ value: modelValue(value), label: `${value.modelId}（不可用）`, disabled: true }] : []),
      ...state.sources.filter(s => s.enabled).map(s => ({ group: s.name,
        items: s.models.map(m => ({ value: modelValue({ sourceId: s.id, modelId: m.id }), label: m.name }))
      }))
    ]} />;
}
export function ProjectPicker({ value, onChange, includeArchived = false, disabled = false, width = 'fill', id, 'aria-describedby': describedBy }: {
  id?: string;
  'aria-describedby'?: string;
  value: string | null;
  onChange: (id: string | null) => void;
  includeArchived?: boolean;
  disabled?: boolean;
  width?: DropdownWidth;
}) {
  const { state } = useApp();
  return <Dropdown className="project-picker" width={width} id={id} aria-describedby={describedBy} aria-label="所属项目"
    value={value ?? ''} onChange={next => onChange(next || null)} disabled={disabled} allowDeselect={false}
    checkIconPosition="right" maxDropdownHeight="var(--size-modelMenuMaxHeight)"
    comboboxProps={{ width: 'max-content', position: 'bottom-start' }}
    data={[
      { value: '', label: '不在项目中' },
      ...state.projects.filter(p => includeArchived || !p.archived || p.id === value).map(p => ({
        value: p.id, label: p.name + (p.archived ? '（已归档）' : ''), disabled: p.archived && !includeArchived
      }))
    ]} />;
}
export function Hint({ label, children, position, className, interactive }: { label: string; children: ReactElement; position?: TooltipProps['position']; className?: string; interactive?: boolean }) {
  return <Tooltip label={label} position={position} className={className} interactive={interactive} withArrow multiline maw="var(--size-tooltip)" openDelay={300} events={{ hover: true, focus: true, touch: false }}>{children}</Tooltip>;
}
export function Field({ label, children, hint, htmlFor }: {
  label: string;
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}) {
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const control = !htmlFor && isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined }) : children;
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {control}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}
export function Empty({ title, children, art, compact = false }: {
  title: string;
  children?: ReactNode;
  art: keyof typeof emptyArt;
  compact?: boolean;
}) {
  return <div className={`empty${compact ? ' empty-compact' : ''}`}>
    <img className="empty-art" data-empty-art={art} src={emptyArt[art]} alt="" aria-hidden="true" draggable={false} />
    <h3>
      {title}
    </h3>
    {children && <p>
      {children}
    </p>}
  </div>;
}
export function Modal({ title, onClose, onSubmit, children, submit = '保存', wide = false, confirmation = false }: {
  title: string;
  onClose: () => void;
  onSubmit?: () => Promise<void>;
  children: ReactNode;
  submit?: string;
  wide?: boolean;
  confirmation?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  useEffect(() => setOpened(true), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!opened || lock.current || !onSubmit)
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await onSubmit();
      setOpened(false);
    }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return <MantineModal opened={opened} onClose={() => { if (!lock.current) setOpened(false); }} onExitTransitionEnd={onClose} title={title}
    size={wide ? 'var(--size-modalWide)' : 'var(--size-modal)'} centered closeOnClickOutside={!busy} closeOnEscape={!busy}
    closeButtonProps={{ disabled: busy, 'aria-label': '关闭对话框' }}
    classNames={{ content: `modal${wide ? ' wide' : ''}`, header: 'modal-header', body: 'modal-container' }}>
    <form onSubmit={save}>
      <div className="modal-body">
        {children}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer">
        <Button type="button" data-autofocus={confirmation || undefined} onClick={() => setOpened(false)} disabled={busy || !opened}>{onSubmit ? '取消' : '关闭'}</Button>
        {onSubmit && <Button type="submit" className="primary" loading={busy} disabled={busy || !opened} onClick={e => { if (confirmation && e.detail > 1) e.preventDefault(); }} onKeyDown={e => { if (confirmation && e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); }}>{busy ? '处理中…' : submit}</Button>}
      </div>
    </form>
  </MantineModal>;
}
export function Confirm({ title, children, onClose, onConfirm, submit = '确认' }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  submit?: string;
}) {
  return <Modal title={title} onClose={onClose} onSubmit={onConfirm} submit={submit}>
    {children}
  </Modal>;
}
export function ContextEditor({ value, onChange, projectId, scopeType, scopeId, onNavigate, dateReadOnly = false, initialSection, businessComponentsDisabled=false }: {
  value: ContextSelection;
  onChange: (v: ContextSelection) => void;
  projectId: string | null;
  scopeType: 'conversation' | 'schedule';
  scopeId: string | null;
  onNavigate?: () => void;
  dateReadOnly?: boolean;
  initialSection?: 'mcp';
  businessComponentsDisabled?:boolean;
}) {
  const { state, go } = useApp();
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const mcpSection=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(initialSection==='mcp'){mcpSection.current?.scrollIntoView({block:'start'});mcpSection.current?.querySelector('summary')?.focus();}},[initialSection]);
  const currentScope = `${projectId}:${scopeType}:${scopeId}`;
  const latest = useRef({currentScope,value,onChange}); latest.current = {currentScope,value,onChange};
  useEffect(() => setSnapshotOpen(false), [currentScope]);
  const project = state.projects.find(item => item.id === projectId);
  const validRepository = project?.repository && !project.archived && state.gitAccount?.credentialConfigured && project.repository.connectionId === state.gitAccount.connectionId;
  const knowledge = state.knowledge.filter(k => !k.removed && k.projectId === projectId);
  const tasks = state.tasks.filter(t => !t.deletedAt && t.projectId === projectId && (!value.date || taskCalendarDate(t) === value.date));
  const grants = state.grants.filter(g => !g.revoked && g.capabilityType === 'tool' && g.scopeType === scopeType && g.scopeId === scopeId);
  const patch = (v: Partial<ContextSelection>) => onChange({ ...value, ...v });
  return <div className="context-editor">
    <Button type="button" onClick={() => onChange({ ...value, taskIds: [], knowledgeRefs: [], skillRef: null, mcpRefs: [] })}>
      清除任务、资料与能力选择
    </Button>
    <Field label={dateReadOnly ? '日期上下文（月历选择）' : '日期上下文（可清除）'} hint={dateReadOnly ? '随 Home 月历选择，自动携带当天全部待办（含已完成及其他项目）。' : value.calendarTasks ? '发送时携带当天全部待办作为只读参考；清空日期即停止自动携带。' : undefined}>
      <TextInput type="date" readOnly={dateReadOnly} value={value.date ?? ''} onChange={e => patch({ date: e.target.value || null, ...(!e.target.value ? { calendarTasks: false } : {}), taskIds:[] })} />
    </Field>
    <details open>
      <summary>
        选择日期任务 ·
        {value.taskIds.length}
        项
      </summary>
      {tasks.length ? tasks.map(t => <Checkbox className="check" key={t.id} label={<>{t.title}<small>{t.date} · v{t.version}</small></>}
         checked={value.taskIds.includes(t.id)} onChange={e => patch({ taskIds: e.target.checked ? [...value.taskIds, t.id] : value.taskIds.filter(id => id !== t.id) })} />) : <p className="muted">
        当前范围没有待办。
      </p>}
    </details>
    <Field label="Skill（一次选择一个）">
      <NativeSelect disabled={businessComponentsDisabled} value={value.skillRef?.id ?? ''} onChange={e => {
        const s = state.skills.find(s => s.id === e.target.value);
        patch({ skillRef: s ? { id: s.id, version: s.version } : null });
      }}>
        <option value="">
          不使用 Skill
        </option>
        {state.skills.filter(s => s.enabled && (!s.ownerPluginId || state.plugins.find(p => p.id === s.ownerPluginId)?.enabled)).map(s => <option key={s.id} value={s.id}>
          {s.name}
          · v
          {s.version}
          {s.ownerPluginId ? ' · Plugin' : ''}
        </option>)}
      </NativeSelect>
    </Field>
    <details open>
      <summary>
        知识资料 ·
        {value.knowledgeRefs.length}
        项
      </summary>
      {validRepository && <Button type="button" onClick={() => setSnapshotOpen(true)}>从仓库添加</Button>}
      {knowledge.map(k => {
        const ref = value.knowledgeRefs.find(r => r.id === k.id);
        return <div className="knowledge-choice" key={k.id}>
          <Checkbox className="check" label={<>{k.name}<small>v{ref?.version ?? k.version}</small></>}
            checked={!!ref} onChange={e => patch({ knowledgeRefs: e.target.checked ? [...value.knowledgeRefs, { id: k.id, version: k.version }] : value.knowledgeRefs.filter(r => r.id !== k.id) })} />
          {ref && <Field label="实际发送片段（可编辑）" hint={(ref.excerpt?.length ?? 0) > 30000 ? '内容超过30000字，请选取并编辑需要发送的片段。' : '仅发送这里显示的内容。'}>
            <Textarea rows={3} value={ref.excerpt ?? k.content} onChange={e => patch({ knowledgeRefs: value.knowledgeRefs.map(r => r.id === k.id ? { ...r, excerpt: e.target.value } : r) })} />
          </Field>}
        </div>;
      })}
      {!knowledge.length && <p className="muted">
        先在知识库创建或导入资料。
      </p>}
    </details>
    <details open ref={mcpSection}>
      <summary tabIndex={0}>
        MCP 已授权能力
      </summary>
      {state.mcpServers.filter(m => !businessComponentsDisabled && m.enabled && (!m.ownerPluginId || state.plugins.find(p => p.id === m.ownerPluginId)?.enabled)).map(m => {
        const allowed = grants.filter(g => g.mcpId === m.id && g.configVersion === m.configVersion).filter((g, i, list) => list.findIndex(item => item.capabilityName === g.capabilityName) === i);
        if (!allowed.length)
          return null;
        const names = value.mcpRefs.find(r => r.id === m.id)?.capabilityNames ?? [];
        return <fieldset key={m.id}>
          <legend>
            {m.name}
            · 配置 v
            {m.configVersion}
          </legend>
          {allowed.map(g => <Checkbox className="check" key={g.id} label={`${g.capabilityType === 'resource' ? '资源' : '工具'} · ${g.capabilityName}`}
             checked={names.includes(g.capabilityName)} onChange={e => {
              const next = e.target.checked ? [...names, g.capabilityName] : names.filter(n => n !== g.capabilityName);
              patch({ mcpRefs: [...value.mcpRefs.filter(r => r.id !== m.id), ...(next.length ? [{ id: m.id, configVersion: m.configVersion, capabilityNames: next }] : [])] });
            }} />)}
        </fieldset>;
      })}
      <p className="muted">
        资源在插件页按此范围授权、读取后，可保存为知识资料并主动选择。只展示此
        {scopeType === 'conversation' ? '聊天' : '计划'}
        的有效只读授权。
        {!scopeId ? '保存后可在插件 → MCP 中授权。' : ''}
      </p>
      <Button type="button" onClick={() => { onNavigate?.(); go('插件'); }}>
        管理 MCP 授权
      </Button>
    </details>
    {snapshotOpen && validRepository && projectId && <RepositorySnapshot key={currentScope} projectId={projectId} onClose={() => setSnapshotOpen(false)} onImported={knowledge => {
      const current = latest.current;
      if (current.currentScope !== currentScope || knowledge.projectId !== projectId) return;
      current.onChange({...current.value, knowledgeRefs:[...current.value.knowledgeRefs.filter(ref => ref.id !== knowledge.id), {id:knowledge.id,version:knowledge.version}]});
    }} />}
  </div>;
}
