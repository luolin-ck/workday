import { Button, NativeSelect, TextInput, Textarea } from '@mantine/core';
import { Icon } from './icons';
import { useState } from 'react';
import { emptyContext, type Schedule, type ScheduleRun, type ScheduleSpec } from '../shared/types';
import { ContextEditor, Empty, Field, localDate, Modal, ModelPicker, ProjectPicker, stamp, useAction, useApp } from './ui';
function ScheduleEditor({ schedule, onClose }: {
  schedule?: Schedule;
  onClose: () => void;
}) {
  const { state, call } = useApp();
  const [name, setName] = useState(schedule?.name ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [projectId, setProjectId] = useState(schedule?.projectId ?? null);
  const [model, setModel] = useState(schedule?.model ?? state.defaultModel);
  const [context, setContext] = useState(schedule?.context ?? emptyContext());
  const [kind, setKind] = useState<ScheduleSpec['kind']>(schedule?.spec.kind ?? 'daily');
  const [date, setDate] = useState(schedule?.spec.kind === 'once' ? schedule.spec.date : localDate());
  const [startDate, setStartDate] = useState(schedule?.spec.kind === 'biweekly' ? schedule.spec.startDate : localDate());
  const [time, setTime] = useState(schedule?.spec.time ?? '09:00');
  const [timezone, setTimezone] = useState(schedule?.spec.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekday, setWeekday] = useState(schedule?.spec.kind === 'weekly' ? schedule.spec.weekday : 1);
  return <Modal title={schedule ? '编辑定时任务' : '创建定时任务'} wide onClose={onClose} onSubmit={async () => {
    if (!model)
      throw new Error('请选择固定的模型源与模型。');
    const spec: ScheduleSpec = kind === 'once' ? { kind, date, time, timezone } : kind === 'weekly' ? { kind, weekday, time, timezone } : kind === 'biweekly' ? { kind, startDate, time, timezone } : { kind, time, timezone };
    await call('schedules.save', { ...(schedule ? { id: schedule.id, expectedVersion: schedule.version } : {}), name: name.trim(), prompt, projectId, model, context, spec });
  }}>
    <Field label="计划名称">
      <TextInput required data-autofocus maxLength={100} value={name} onChange={e => setName(e.target.value)} />
    </Field>
    <div className="form-row">
      <Field label="执行频率">
        <NativeSelect value={kind} onChange={e => setKind(e.target.value as ScheduleSpec['kind'])}>
          <option value="once">
            一次
          </option>
          <option value="daily">
            每天
          </option>
          <option value="weekly">
            每周
          </option>
          <option value="biweekly">每两周</option>
        </NativeSelect>
      </Field>
      {kind === 'once' && <Field label="日期">
        <TextInput type="date" required value={date} onChange={e => setDate(e.target.value)} />
      </Field>}
      {kind === 'biweekly' && <Field label="首次执行日期">
        <TextInput type="date" required value={startDate} onChange={e => setStartDate(e.target.value)} />
      </Field>}
      {kind === 'weekly' && <Field label="星期">
        <NativeSelect value={weekday} onChange={e => setWeekday(Number(e.target.value))}>
          {['一', '二', '三', '四', '五', '六', '日'].map((d, i) => <option value={i + 1} key={d}>
            周
            {d}
          </option>)}
        </NativeSelect>
      </Field>}
      <Field label="当地执行时间">
        <TextInput type="time" required value={time} onChange={e => setTime(e.target.value)} />
      </Field>
    </div>
    <Field label="IANA 时区" hint="例如 Asia/Shanghai 或 America/New_York。显示与执行均依据此时区。">
      <TextInput required value={timezone} onChange={e => setTimezone(e.target.value)} />
    </Field>
    <div className="form-row">
      <Field label="结果所属项目">
        <ProjectPicker value={projectId} onChange={id => {
          setProjectId(id);
          setContext({ ...emptyContext(), date: context.date, skillRef: context.skillRef });
        }} />
      </Field>
      <Field label="固定模型 · 模型源">
        <ModelPicker value={model} onChange={setModel} required />
      </Field>
    </div>
    <Field label="提示词">
      <Textarea required rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：根据选择的资料，生成今天的工作摘要与待办草案。" />
    </Field>
    <details>
      <summary>
        绑定上下文、资料、Skill 与 MCP
      </summary>
      <ContextEditor value={context} onChange={setContext} projectId={projectId} scopeType="schedule" scopeId={schedule?.id ?? null} />
    </details>
    <p className="notice">
      应用运行时执行；退出或休眠错过的计划会记录为错过。仅生成结果与草案，由你确认应用待办。
    </p>
  </Modal>;
}
const statusText: Record<string, string> = { active: '运行中', paused: '已暂停', completed: '已完成', missed: '已错过', running: '执行中', success: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export function Schedules() {
  const { state, call, openChat } = useApp();
  const [edit, setEdit] = useState<Schedule | true | null>(null);
  const [logs, setLogs] = useState<{
    schedule: Schedule;
    runs: ScheduleRun[];
  } | null>(null);
  const { busy, run } = useAction();
  return <section className="page panel">
    <div className="section-heading">
      <div>
        <h1>
          定时任务
        </h1>
      </div>
      <Button type="button" className="primary" onClick={() => setEdit(true)}>
        <Icon name="plus" className="icon-inline" />创建计划
      </Button>
    </div>
    <div className="card-grid">
      {state.schedules.map(s => {
        const source = state.sources.find(src => src.id === s.model.sourceId);
        const running = state.runs.some(r => r.scheduleId === s.id && r.status === 'running');
        return <article className="entry-card" key={s.id}>
          <div className="section-heading">
            <h3>
              {s.name}
            </h3>
            <span className={`tag ${s.enabled ? 'mint' : ''}`}>
              {statusText[s.status] ?? s.status}
            </span>
          </div>
          <p>
            {s.spec.kind === 'once' ? s.spec.date : s.spec.kind === 'daily' ? '每天' : s.spec.kind === 'biweekly' ? `每两周 · 自 ${s.spec.startDate}` : `每周${['', '一', '二', '三', '四', '五', '六', '日'][s.spec.weekday]}`}
            ·
            {s.spec.time}
            ·
            {s.spec.timezone}
          </p>
          <p className="muted">
            {s.model.modelId}
            ·
            {source?.name ?? '源失效'}
            <br />
            {state.projects.find(p => p.id === s.projectId)?.name ?? '不在项目中'}
            <br />
            下次执行：
            {stamp(s.nextRunAt)}
          </p>
          <p className="excerpt">
            {s.prompt}
          </p>
          {s.pauseReason && <p className="notice">
            {s.pauseReason}
          </p>}
          <div className="actions">
            <Button type="button" onClick={() => setEdit(s)}>
              编辑绑定
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(async () => {
              await call('schedules.toggle', { id: s.id, expectedVersion: s.version, enabled: !s.enabled });
            })}>
              {s.enabled ? '暂停' : '启用'}
            </Button>
            <Button type="button" disabled={busy || running} onClick={() => void run(async () => {
              await call('schedules.run', { id: s.id, triggerId: crypto.randomUUID() });
            })}>
              {running ? '执行中…' : '立即运行'}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(async () => {
              const runs = await call('schedules.runs', { id: s.id });
              setLogs({ schedule: s, runs });
            })}>
              运行记录
            </Button>
          </div>
        </article>;
      })}
    </div>
    {!state.schedules.length && <Empty art="schedules" title="为重复工作建立一个节奏">
      选择一次、每天、每周或每两周，绑定固定模型和所需资料。
    </Empty>}
    {edit && <ScheduleEditor schedule={edit === true ? undefined : edit} onClose={() => setEdit(null)} />}

    {logs && <Modal title={`${logs.schedule.name} · 运行记录`} wide onClose={() => setLogs(null)}>
      <div className="actions">
        <Button type="button" disabled={busy} onClick={() => void run(async () => {
          const runs = await call('schedules.runs', { id: logs.schedule.id });
          setLogs({ ...logs, runs });
        })}>
          刷新记录
        </Button>
      </div>
      {logs.runs.map(r => <article className="run-log" key={r.id}>
        <div className="section-heading">
          <strong>
            {statusText[r.status] ?? r.status}
          </strong>
          <span className="tag">
            {r.triggerType === 'manual' ? '手动' : '自动'}
          </span>
        </div>
        <p>
          预定：
          {stamp(r.scheduledFor)}
          <br />
          开始：
          {stamp(r.startedAt)}
          · 结束：
          {stamp(r.endedAt)}
        </p>
        <p className="muted">
          {r.model.modelId}
          ·
          {state.sources.find(s => s.id === r.model.sourceId)?.name ?? '源失效'}
        </p>
        {r.error && <p className="error">
          {r.error}
        </p>}
        {r.conversationId && <Button type="button" onClick={() => {
          openChat(r.conversationId!);
          setLogs(null);
        }}>
          打开结果聊天<Icon name="arrow-right" className="icon-suffix" />
        </Button>}
      </article>)}
      {!logs.runs.length && <Empty art="runHistory" title="还没有运行记录">
        执行后会记录模型、状态与结果聊天。
      </Empty>}
    </Modal>}
  </section>;
}
