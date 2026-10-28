import { ActionIcon, Button, Checkbox, Menu, NativeSelect, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { Icon } from './icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Solar } from 'lunar-typescript';
import { DateTime } from 'luxon';
import { calendarMeetings, calendarSchedules, taskCalendarDate } from '../shared/dates';
import type { HolidayResult, Meeting, MeetingsResult, Task, TaskPriority, WeatherPreference } from '../shared/types';
import { Hint, Field, localDate, Modal, ProjectPicker, useAction, useApp } from './ui';
import { WeatherBlock } from './weather';
import emptyTasksArt from '../../assets/illustrations/tasks-empty.png';
const taskPriorities: TaskPriority[] = ['P0', 'P1', 'P2'];
const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const lunarDayNames = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
];
export function lunarDate(day: Date) {
  // Convert the cell's civil date, independent of the device's timezone.
  const civilDate = new Date(0);
  civilDate.setUTCFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  civilDate.setUTCHours(12);
  const parts: { type: string; value: string }[] = lunarFormatter.formatToParts(civilDate);
  const month = parts.find(part => part.type === 'month')!.value;
  const number = Number(parts.find(part => part.type === 'day')!.value);
  const name = lunarDayNames[number - 1];
  const year = parts.find(part => part.type === 'yearName')!.value;
  return { label: number === 1 ? month : name, full: `农历${year}年${month}${name}` };
}
export function solarTerm(day: Date) {
  // The library uses Beijing civil dates; never convert the cell through UTC.
  return Solar.fromYmd(day.getFullYear(), day.getMonth() + 1, day.getDate()).getLunar().getJieQi();
}
const lunarFestivals: Record<string, string> = {
  '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节',
  '7-7': '七夕', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节',
  '12-8': '腊八节', '12-23': '北方小年', '12-24': '南方小年'
};
const solarFestivals: Record<string, string> = {
  '1-1': '元旦', '2-14': '情人节', '5-1': '劳动节', '6-1': '儿童节',
  '10-1': '国庆节', '10-31': '万圣节', '12-24': '平安夜', '12-25': '圣诞节'
};
const weekdayFestivals: Record<string, string> = {
  '5-2-0': '母亲节', '6-3-0': '父亲节', '11-4-4': '感恩节（美国）'
};
export function calendarAnnotation(day: Date) {
  const solar = Solar.fromYmd(day.getFullYear(), day.getMonth() + 1, day.getDate());
  const lunar = solar.getLunar();
  const term = lunar.getJieQi();
  // Leap months have negative month numbers, so festivals only match regular months.
  const festivals = [
    lunarFestivals[`${lunar.getMonth()}-${lunar.getDay()}`],
    solarFestivals[`${day.getMonth() + 1}-${day.getDate()}`],
    weekdayFestivals[`${day.getMonth() + 1}-${Math.ceil(day.getDate() / 7)}-${day.getDay()}`]
  ].filter(Boolean);
  if (lunar.getMonth() === 12 && lunar.getDay() >= 29 && lunar.next(1).getYear() !== lunar.getYear()) festivals.unshift('除夕');
  if (term === '清明') festivals.push('清明节');
  const label = [...festivals, ...(term && term !== '清明' ? [term] : [])].join(' · ');
  return { festivals, term, label };
}
export function monthDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const offset = first.getDay();
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i - offset + 1, 12));
}
export function TaskEditor({ task, date, onClose }: {
  task?: Task;
  date: string;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [planned, setPlanned] = useState(task?.date ?? date);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [projectId, setProjectId] = useState(task?.projectId ?? null);
  const [completed, setCompleted] = useState(task?.completed ?? false);
  const [completedDate, setCompletedDate] = useState(task?.completed ? taskCalendarDate(task) : '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'P2');
  return <Modal title={task ? '编辑待办' : '新增待办'} onClose={onClose} onSubmit={async () => {
    await call('tasks.save', { ...(task ? { id: task.id, expectedVersion: task.version } : {}), title: title.trim(), notes, date: planned, dueDate: dueDate || null, projectId, completed, completedDate: completed ? completedDate : null, priority });
  }}>
    <Field label="内容">
      <TextInput data-autofocus required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} />
    </Field>
    <Field label="优先级">
      <NativeSelect aria-label="优先级" value={priority} onChange={event => setPriority(event.currentTarget.value as TaskPriority)}>
        {taskPriorities.map(value => <option value={value} key={value}>{value}</option>)}
      </NativeSelect>
    </Field>
    {task && <>
      <div className="form-row">
        <Field label="待办日期">
          <TextInput type="date" required value={planned} onChange={e => setPlanned(e.target.value)} />
        </Field>
        <Field label="截止日期">
          <TextInput type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        </Field>
      </div>
      <Field label="所属项目">
        <ProjectPicker value={projectId} onChange={setProjectId} />
      </Field>
      <Field label="备注">
        <Textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
      </Field>
      <div className="task-completion-field">
        <Checkbox className="check" checked={completed} onChange={e => {
          const checked=e.target.checked;setCompleted(checked);setCompletedDate(checked?localDate():'');
        }} label="已完成" />
        {completed && <TextInput type="date" aria-label="完成日期" required value={completedDate} onChange={e => setCompletedDate(e.target.value)} />}
      </div>
    </>}
  </Modal>;
}
function meetingTime(meeting:Meeting,timezone:string) {
  if(meeting.allDay)return '全天';
  const start=DateTime.fromISO(meeting.start).setZone(timezone),end=DateTime.fromISO(meeting.end).setZone(timezone);
  return start.toISODate()===end.toISODate()?`${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`:`${start.toFormat('MM/dd HH:mm')}–${end.toFormat('MM/dd HH:mm')}`;
}
export function Calendar({ date, onDate, month:controlledMonth, onMonth, meetings, meetingsLoading, onMeetingsRefresh }: {
  date: string;
  onDate: (date: string) => void;
  month?:Date;
  onMonth?:(month:Date)=>void;
  meetings?:MeetingsResult|null;
  meetingsLoading?:boolean;
  onMeetingsRefresh?:(requestAccess?:boolean)=>Promise<void>;
}) {
  const { state, call, refresh, report } = useApp();
  const { busy, run } = useAction();
  const today = localDate();
  const [ownMonth, setOwnMonth] = useState(() => new Date(`${date}T12:00:00`));
  const month=controlledMonth??ownMonth,setMonth=onMonth??setOwnMonth;
  const [holidayResults, setHolidayResults] = useState<Record<number, HolidayResult>>({});
  const [loadingYears, setLoadingYears] = useState<Set<number>>(new Set());
  const requestedYears = useRef(new Set<number>());
  const requests = useRef(new Map<number, number>());
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const days = useMemo(() => monthDays(month), [month]);
  const annotations = useMemo(() => days.map(calendarAnnotation), [days]);
  const visibleYears = [...new Set(days.map(day => day.getFullYear()))].sort((a, b) => a - b);
  const yearsKey = visibleYears.join(',');
  const holidayMarks = new Map(visibleYears.flatMap(year => holidayResults[year]?.data?.days ?? []).map(mark => [mark.date, mark]));
  const loading = visibleYears.some(year => loadingYears.has(year));
  const tasks = state.tasks.filter(t => !t.deletedAt);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const meetingDays=useMemo(()=>meetings?.status==='ready'?calendarMeetings(meetings.meetings,meetings.startDate,meetings.endDate,meetings.timezone):new Map<string,Meeting[]>(),[meetings]);
  const scheduledDays = calendarSchedules(state.schedules, state.runs, localDate(days[0]), localDate(days[days.length - 1]), new Date().toISOString(), timezone);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1, 12));
  async function queryYear(year: number, refresh = false) {
    const sequence = ++requestSequence.current;
    requestedYears.current.add(year);
    requests.current.set(year, sequence);
    setLoadingYears(previous => new Set(previous).add(year));
    try {
      const result = await call('holidays.query', { year, ...(refresh ? { refresh: true } : {}) });
      if (result.year !== year || (result.data && result.data.year !== year)) throw new Error('节假日查询返回的年份不一致。');
      if (!mounted.current || requests.current.get(year) !== sequence) return;
      setHolidayResults(previous => ({ ...previous, [year]: { ...result, data: result.data ?? previous[year]?.data ?? null } }));
      if (refresh && result.status === 'error') report(`${year}年节假日刷新失败，保留已有安排：${result.message ?? '请稍后重试'}`);
    } catch (error) {
      if (!mounted.current || requests.current.get(year) !== sequence) return;
      setHolidayResults(previous => ({ ...previous, [year]: { year, data: previous[year]?.data ?? null, status: 'error', message: error instanceof Error ? error.message : String(error) } }));
      if (refresh) report(`${year}年节假日刷新失败，保留已有安排：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (mounted.current && requests.current.get(year) === sequence) {
        setLoadingYears(previous => { const next = new Set(previous); next.delete(year); return next; });
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requests.current.clear(); requestedYears.current.clear(); };
  }, []);
  useEffect(() => {
    for (const year of visibleYears) {
      if (!requestedYears.current.has(year)) void queryYear(year);
    }
  // Provider state updates must not start another annual query.
  }, [yearsKey]);
  return <section className="calendar panel">
    <div className="section-heading">
      <div>
        <div className="calendar-title">
          <h1>
            {month.getFullYear()}
            年
            <span>
              {month.getMonth() + 1}
              月
            </span>
          </h1>
          <Hint label={busy || loading ? '刷新中…' : '刷新日历'}><span className="hint-target" tabIndex={busy || loading ? 0 : undefined}><ActionIcon type="button" className="calendar-refresh" aria-label="刷新日历" disabled={busy || loading} aria-busy={busy || loading} onClick={() => void run(async () => {
            await Promise.all([refresh(), onMeetingsRefresh?.(), ...visibleYears.map(year => queryYear(year, true))]);
          })}>
            <Icon name={busy || loading ? 'loader-circle' : 'refresh-cw'} size="md" />
          </ActionIcon></span></Hint>
          {onMeetingsRefresh && <CalendarMeetingsControl result={meetings} loading={meetingsLoading} busy={busy} refresh={onMeetingsRefresh} />}
        </div>
      </div>
      <div className="actions">
        <ActionIcon type="button" aria-label="上个月" onClick={() => shift(-1)}>
          <Icon name="chevron-left" />
        </ActionIcon>
        <ActionIcon type="button" aria-label="下个月" onClick={() => shift(1)}>
          <Icon name="chevron-right" />
        </ActionIcon>
        <Button type="button" onClick={() => {
          setMonth(new Date(`${today}T12:00:00`));
          onDate(today);
        }}>
          今天
        </Button>
      </div>
    </div>
    <div className="weekdays">
      {['日', '一', '二', '三', '四', '五', '六'].map(d => <span key={d}>
        {d}
      </span>)}
    </div>
    <div className="month-grid">
      {days.map((day, i) => {
        const key = localDate(day);
        const lunar = lunarDate(day);
        const annotation = annotations[i];
        const holiday = holidayMarks.get(key);
        const holidayDescription = holiday ? `${holiday.name}，${holiday.kind === 'rest' ? '放假休息' : '调休上班'}` : '';
        const shortName = holiday?.name.replace(/(清明|劳动|端午|中秋|国庆)节/g, '$1').replace(/、/g, '·');
        const daily = tasks.filter(t => taskCalendarDate(t) === key);
        const pending = daily.filter(t => !t.completed);
        const pendingPriority = taskPriorities.find(priority => pending.some(task => task.priority === priority)) ?? 'P2';
        const done = daily.length - pending.length;
        const overdue = pending.filter(t => t.dueDate && t.dueDate < today).length;
        const due = tasks.filter(t => !t.completed && t.dueDate === key);
        const deadlineLabel = `本日截止 ${due.length} 项`;
        const deadlineDetails = `${deadlineLabel}：${due.map(t => t.title).join('；')}`;
        const scheduled = scheduledDays.get(key) ?? [];
        const dailyMeetings=meetingDays.get(key)??[];
        const meetingDetails=dailyMeetings.map(meeting=>`${meetingTime(meeting,meetings!.timezone)} ${meeting.title}`).join('；');
        const scheduleCount = new Set(scheduled.map(s => s.scheduleId)).size;
        const scheduleDetails = scheduled.map(s => {
          const instant = DateTime.fromISO(s.at), time = instant.setZone(timezone).toFormat('HH:mm');
          const origin = s.status === 'scheduled' && s.timezone !== timezone ? `（${s.timezone} ${instant.setZone(s.timezone).toFormat('MM-dd HH:mm')}）` : '';
          const status = { scheduled:'待执行', running:'执行中', success:'已执行', failed:'失败', cancelled:'已取消', interrupted:'已中断', missed:'已错过' }[s.status];
          return `${s.name} ${time}${origin} · ${s.gap ? '夏令时该时间不存在，' : ''}${status}`;
        }).join('；');
        return <Hint key={key} label={`${key} · ${lunar.full}${annotation.label ? ` · ${annotation.label}` : ''}${holiday ? ` · ${holidayDescription}` : ''}${due.length ? ` · ${deadlineDetails}` : ''}${scheduleCount ? ` · 定时任务 ${scheduleCount} 项：${scheduleDetails}` : ''}${dailyMeetings.length ? ` · 会议 ${dailyMeetings.length} 项：${meetingDetails}` : ''}`}><UnstyledButton type="button" className={`day ${day.getMonth() !== month.getMonth() ? 'outside' : ''} ${i % 7 === 0 || i % 7 === 6 ? 'weekend' : ''} ${key === date ? 'selected' : ''}`} data-holiday={holiday?.kind} aria-label={`${key}，${lunar.full}，${annotation.label ? `${annotation.label}，` : ''}${holidayDescription ? `${holidayDescription}，` : ''}${pending.length}项未完成，${done}项已完成${overdue ? `，其中${overdue}项逾期` : ''}${due.length ? `，${due.length}项待办本日截止` : ''}${scheduleCount ? `，${scheduleCount}项定时任务` : ''}${dailyMeetings.length ? `，${dailyMeetings.length}项会议` : ''}`} aria-pressed={key === date} onClick={() => onDate(key)}>
          <div className="day-heading">
            <span className={`calendar-date${due.length ? ' has-deadline' : ''}`}>
              <span className="calendar-day-number">
                <span className={`day-number ${key === today ? 'today' : ''}`}>
                  {day.getDate()}
                </span>
                {due.length > 0 && <span className="deadline-mark" aria-label={deadlineLabel}>
                  <Icon name="calendar-clock" size="xs" />
                </span>}
              </span>
              <span className={`lunar-date${annotation.term ? ' solar-term' : ''}${annotation.festivals.length ? ' festival' : ''}`} aria-hidden="true">{annotation.label || lunar.label}</span>
            </span>
            {holiday && <Hint label={holidayDescription}><span className={`holiday-mark ${holiday.kind}`} aria-hidden="true">
              {holiday.kind === 'rest' && <span className="holiday-name">{shortName}</span>}
              <span className="holiday-kind">{holiday.kind === 'rest' ? '休' : '班'}</span>
            </span></Hint>}
          </div>
          <div className="day-summary">
          {(scheduleCount>0||dailyMeetings.length>0)&&<div className="day-events">
            {scheduleCount > 0 && <span className="schedule-count" aria-label={`定时任务 ${scheduleCount} 项`}><Icon name="alarm-clock" size="sm" />{scheduleCount}</span>}
            {dailyMeetings.length>0&&<span className="meeting-count" aria-label={`会议 ${dailyMeetings.length} 项`}><Icon name="presentation" size="sm" />{dailyMeetings.length}</span>}
          </div>}
          <div className="day-tasks">
            {pending.length > 0 && <Hint label={`待办 ${pending.length} 项`}><span className="pending-count" data-pending-priority={pendingPriority} aria-label={`待办 ${pending.length} 项`}><Icon name="circle" size="sm" />{pending.length}</span></Hint>}
            {done > 0 && <Hint label={`已完成 ${done} 项`}><span className="done-count" aria-label={`已完成 ${done} 项`}><Icon name="check" size="sm" />{done}</span></Hint>}
            {overdue > 0 && <Hint label={`逾期 ${overdue} 项（包含在待办中）`}><span className="overdue-count" aria-label={`逾期 ${overdue} 项（包含在待办中）`}><Icon name="triangle-alert" size="sm" />{overdue}</span></Hint>}
          </div>
          </div>
        </UnstyledButton></Hint>;
      })}
    </div>
    <div className="calendar-legend">
      <span>
        <Icon name="circle" size="sm" className="icon-inline" />待办
      </span>
      <span>
        <Icon name="check" size="sm" className="icon-inline" />已完成
      </span>
      <Hint label="未完成且已超过截止日期，包含在待办总数中"><span tabIndex={0} className="overdue-legend">
        <Icon name="triangle-alert" size="sm" className="icon-inline" />逾期
      </span></Hint>
      {meetings?.status==='ready'&&<span><Icon name="presentation" size="sm" className="icon-inline" />会议</span>}
    </div>
  </section>;
}
function CalendarMeetingsControl({ result, loading, busy, refresh }: {
  result?: MeetingsResult | null;
  loading?: boolean;
  busy: boolean;
  refresh: (requestAccess?: boolean) => Promise<void>;
}) {
  const status = result?.status;
  const label = loading ? '正在同步钉钉日历' : status === 'notDetermined' ? '连接钉钉日历' : status === 'unsupported' ? '钉钉日历不可用' : status && status !== 'ready' ? '重试同步钉钉日历' : '同步钉钉日历';
  const description = loading ? label : status === 'ready' ? `已连接 · ${label}` : result?.message ? `${result.message} · ${label}` : label;
  const disabled = busy || loading || status === 'unsupported';
  return <Hint label={description}><span className="hint-target" tabIndex={disabled ? 0 : undefined} aria-label={disabled ? description : undefined}>
    <ActionIcon type="button" className="calendar-refresh calendar-meetings-control" data-state={loading ? 'loading' : status ?? 'idle'} aria-label={label} aria-description={description} aria-busy={!!loading} disabled={disabled} onClick={() => void refresh(status === 'notDetermined')}>
      <Icon name={loading ? 'loader-circle' : 'presentation'} size="md" />
    </ActionIcon>
  </span></Hint>;
}

export function DayTasks({ date, weatherPreference, meetings, meetingsLoading }: {
  date: string;
  weatherPreference: WeatherPreference;
  meetings?:MeetingsResult|null;
  meetingsLoading?:boolean;
}) {
  const { state, call } = useApp();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Task | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [newTitles, setNewTitles] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const drafts = useRef(titles);
  const bases = useRef(new Map<string, Task>());
  const pending = useRef(new Map<string, Promise<Task>>());
  const newInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const today = localDate();
  const visible = state.tasks.filter(t => !t.deletedAt && taskCalendarDate(t) === date);
  const creating = newTitles[date] !== undefined;
  useEffect(() => {
    if (creating) {
      newInput.current?.focus({ preventScroll: true });
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
    }
  }, [date, creating]);
  function changeTitle(id: string, title?: string) {
    const next = { ...drafts.current };
    if (title === undefined) { delete next[id]; bases.current.delete(id); }
    else next[id] = title;
    drafts.current = next;
    setTitles(next);
    setErrors(previous => ({ ...previous, [id]: '' }));
  }
  async function saveTitle(task: Task): Promise<Task> {
    const underway = pending.current.get(task.id);
    if (underway) return underway;
    const title = drafts.current[task.id];
    if (title === undefined) return task;
    if (title.trim() === task.title) { changeTitle(task.id); return task; }
    const base = bases.current.get(task.id) ?? task;
    const request = (async () => {
      try {
        if (!title.trim()) throw new Error('内容不能为空');
        const saved = await call('tasks.save', { id: base.id, expectedVersion: base.version, title: title.trim(), notes: base.notes, date: base.date, dueDate: base.dueDate, projectId: base.projectId, completed: base.completed });
        changeTitle(task.id);
        return saved;
      } catch (error) {
        bases.current.delete(task.id);
        setErrors(previous => ({ ...previous, [task.id]: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    })();
    pending.current.set(task.id, request);
    setSaving(previous => new Set(previous).add(task.id));
    try { return await request; }
    finally {
      pending.current.delete(task.id);
      setSaving(previous => { const next = new Set(previous); next.delete(task.id); return next; });
    }
  }
  function act(task: Task, action: (saved: Task) => unknown | Promise<unknown>) {
    void run(async () => action(await saveTitle(task)));
  }
  function removeNew(planned: string) {
    setNewTitles(previous => { const next = { ...previous }; delete next[planned]; return next; });
    setErrors(previous => ({ ...previous, [`new:${planned}`]: '' }));
  }
  async function saveNew(planned: string, title: string) {
    const key = `new:${planned}`;
    if (pending.current.has(key)) return false;
    if (!title.trim()) { removeNew(planned); return true; }
    setErrors(previous => ({ ...previous, [key]: '' }));
    const request = call('tasks.save', { title: title.trim(), notes: '', date: planned, dueDate: null, projectId: null, completed: false });
    pending.current.set(key, request);
    setSaving(previous => new Set(previous).add(key));
    try { await request; removeNew(planned); return true; }
    catch (error) { setErrors(previous => ({ ...previous, [key]: error instanceof Error ? error.message : String(error) })); return false; }
    finally {
      pending.current.delete(key);
      setSaving(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  }
  return <section className="day-panel panel">
    <div className="section-heading day-heading">
      <div className="day-date">
        <h2>
          {Number(date.slice(5, 7))}
          月
          {Number(date.slice(8))}
          日
        </h2>
        <p>
          {new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'long' })}
          {date === today ? ' · 今天' : ''}
        </p>
      </div>
      <WeatherBlock date={date} preference={weatherPreference} />
    </div>
    <div className="task-list" ref={list}>
      <DayMeetings date={date} result={meetings} loading={meetingsLoading} />
      <section className="day-group day-items" aria-label="事项">
        <DayGroupHeading icon="square" title="事项" count={visible.length} />
      {visible.map(t => {
        const project = state.projects.find(p => p.id === t.projectId);
        const projectName = t.projectId ? project?.name ?? '项目' : '空';
        const changeProject = (projectId: string | null) => {
          if (projectId === t.projectId) return;
          act(t, saved => call('tasks.save', { id: saved.id, expectedVersion: saved.version, title: saved.title, notes: saved.notes, date: saved.date, dueDate: saved.dueDate, projectId, completed: saved.completed }));
        };
        return <div className={`task-row ${t.completed ? 'completed' : ''}`} data-task-id={t.id} key={t.id}>
          <Checkbox aria-label={`完成 ${t.title}`} checked={t.completed} disabled={busy} onChange={() => act(t, saved =>
            call('tasks.save', { id: saved.id, expectedVersion: saved.version, title: saved.title, notes: saved.notes, date: saved.date, dueDate: saved.dueDate, projectId: saved.projectId, completed: !saved.completed })
          )} />
        <Hint label={titles[t.id] ?? t.title}><div className="task-title">
          <TextInput aria-label={`待办内容 ${t.title}`} maxLength={300} value={titles[t.id] ?? t.title} readOnly={saving.has(t.id) || busy} error={errors[t.id]}
            onChange={event => { if (!bases.current.has(t.id)) bases.current.set(t.id, t); changeTitle(t.id, event.currentTarget.value); }}
            onBlur={() => void saveTitle(t).catch(() => {})}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape' && !saving.has(t.id)) { changeTitle(t.id); event.currentTarget.blur(); }
            }} />
        </div></Hint>
        <div className="task-actions">
          {t.dueDate && <Hint label={`截止日期：${t.dueDate}`}><span className={`task-deadline ${!t.completed && t.dueDate < today ? 'is-overdue' : ''}`} tabIndex={0} aria-label={`截止日期：${t.dueDate}`}>
            <Icon name="calendar-clock" size="taskAction" />
          </span></Hint>}
          <Menu position="bottom-end" width="var(--size-priorityMenu)" withinPortal>
            <Hint label={`优先级 ${t.priority}`}><span className="task-priority-control"><Menu.Target><UnstyledButton type="button" className="task-priority-picker" data-priority={t.priority} disabled={busy} aria-label={`优先级 ${t.title}：${t.priority}`}>
              {t.priority}
            </UnstyledButton></Menu.Target></span></Hint>
            <Menu.Dropdown aria-label="选择优先级">
              {taskPriorities.map(priority => <Menu.Item key={priority} disabled={busy} rightSection={priority === t.priority ? <Icon name="check" size="sm" /> : undefined} onClick={() => {
                if (priority !== t.priority) act(t, saved => call('tasks.save', { id: saved.id, expectedVersion: saved.version, title: saved.title, notes: saved.notes, date: saved.date, dueDate: saved.dueDate, projectId: saved.projectId, completed: saved.completed, priority }));
              }}><span className="task-priority-label" data-priority={priority}>{priority}</span></Menu.Item>)}
            </Menu.Dropdown>
          </Menu>
          <Menu position="bottom-end" width="var(--size-taskMenu)" withinPortal>
            <Hint label={t.projectId ? `${projectName}${project?.archived ? '（已归档）' : ''}` : '未关联项目'}><span className="task-project-control"><Menu.Target><UnstyledButton type="button" className="task-project-picker tag" disabled={busy} aria-label={`关联项目 ${t.title}：${projectName}`}>
              {Array.from(projectName)[0]}
            </UnstyledButton></Menu.Target></span></Hint>
            <Menu.Dropdown className="task-project-menu" aria-label="关联项目">
              <Menu.Label>关联项目</Menu.Label>
              <Menu.Item disabled={busy} rightSection={!t.projectId ? <Icon name="check" size="sm" /> : undefined} onClick={() => changeProject(null)}>空</Menu.Item>
              {state.projects.filter(p => !p.archived).map(p => <Menu.Item key={p.id} disabled={busy} title={p.name} rightSection={p.id === t.projectId ? <Icon name="check" size="sm" /> : undefined} onClick={() => changeProject(p.id)}>{p.name}</Menu.Item>)}
            </Menu.Dropdown>
          </Menu>
        </div>
        <div className="task-corner-actions">
          <Hint label="编辑与改期"><ActionIcon type="button" size="var(--size-taskCornerAction)" className="task-edit-action" aria-label={`编辑与改期 ${t.title}`} disabled={busy} onClick={() => act(t, saved => setEditing(saved))}>
            <Icon name="pencil" size="taskCornerAction" />
          </ActionIcon></Hint>
          <Hint label="删除待办"><span className="hint-target task-delete-action" tabIndex={busy ? 0 : undefined}><ActionIcon type="button" size="var(--size-taskCornerAction)" className="danger-icon" aria-label={`删除 ${t.title}`} disabled={busy} onClick={() => act(t, saved => call('tasks.delete', { id: saved.id, expectedVersion: saved.version }))}>
            <Icon name="trash" size="taskCornerAction" />
          </ActionIcon></span></Hint>
        </div>
      </div>;
      })}
      {creating && <div className="task-row task-new-row" key={`new:${date}`}>
        <Checkbox disabled aria-label="新待办未保存" />
        <div className="task-title">
          <TextInput ref={newInput} aria-label="新增待办内容" placeholder="新增待办" maxLength={300} value={newTitles[date]} readOnly={saving.has(`new:${date}`)} error={errors[`new:${date}`]}
            onChange={event => { const title = event.currentTarget.value; setNewTitles(previous => ({ ...previous, [date]: title })); setErrors(previous => ({ ...previous, [`new:${date}`]: '' })); }}
            onBlur={event => void saveNew(date, event.currentTarget.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === 'Escape' && !saving.has(`new:${date}`)) { event.preventDefault(); removeNew(date); }
            }} />
        </div>
      </div>}
      {!visible.length && !creating && <div className="day-empty"><img src={emptyTasksArt} alt="暂无待办" draggable={false} /></div>}
      </section>
    </div>
    <div className="task-add">
      <Hint label="新增待办"><ActionIcon type="button" aria-label="新增待办" disabled={busy || saving.has(`new:${date}`)} onMouseDown={event => event.preventDefault()} onClick={async () => {
        if (creating && newTitles[date].trim() && !await saveNew(date, newTitles[date])) return;
        setNewTitles(previous => ({ ...previous, [date]: '' }));
        newInput.current?.focus();
        if (list.current) list.current.scrollTop = list.current.scrollHeight;
      }}><Icon name="plus" /></ActionIcon></Hint>
    </div>
    {editing && <TaskEditor task={editing} date={date} onClose={() => setEditing(null)} />}
  </section>;
}

function DayGroupHeading({icon,title,count}:{icon:'presentation'|'square';title:string;count?:number}) {
  return <h3 className="day-group-heading"><Icon name={icon} size="sm" /><span>{title}</span>{count!==undefined&&<span className="day-group-count">{count}</span>}</h3>;
}

function DayMeetings({date,result,loading}:{date:string;result?:MeetingsResult|null;loading?:boolean}) {
  if(loading||result?.status!=='ready')return null;
  const entries=calendarMeetings(result.meetings,result.startDate,result.endDate,result.timezone).get(date)??[];
  if(!entries.length)return null;
  return <section className="day-group day-meetings" aria-label="钉钉会议">
    <DayGroupHeading icon="presentation" title="会议" count={entries.length} />
    {entries.map(meeting=>{const time=meetingTime(meeting,result.timezone),label=`${time} ${meeting.title}`;return <Hint key={`${meeting.id}/${meeting.start}`} label={label}><div className="meeting-row" tabIndex={0} aria-label={label}>
      <span className="meeting-time">{time}</span><span className="meeting-title">{meeting.title}</span>
    </div></Hint>;})}
  </section>;
}
