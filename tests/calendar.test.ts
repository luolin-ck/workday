import {createElement} from 'react';
import {renderToStaticMarkup as renderMarkup} from 'react-dom/server';
import { WorkDayProvider } from '../src/renderer/component-theme';
const renderToStaticMarkup = (element: React.ReactNode) => renderMarkup(createElement(WorkDayProvider, {appearance:'mono', children:element}));
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Calendar, calendarAnnotation, lunarDate, monthDays, solarTerm} from '../src/renderer/calendar';
import {localDate, RuntimeContext, type Runtime} from '../src/renderer/ui';
import {emptyContext,type Task,type Schedule} from '../src/shared/types';

describe('calendar task summaries', () => {
  afterEach(() => vi.useRealTimers());
  it('colors each day pending count by its highest unfinished priority and updates when that set changes', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 19, 12));
    const task = (id: string, priority: Task['priority'], date='2026-10-19', overrides: Partial<Task> = {}): Task => ({
      id, priority, title:'合成事项 '+id, notes:'', date, dueDate:null, completed:false, completedDate:null, deletedAt:null, projectId:null,
      version:1, createdAt:'2026-10-01T00:00:00Z', updatedAt:'2026-10-01T00:00:00Z', ...overrides
    });
    const tasks = [task('low','P2'), task('medium','P1'), task('high','P0'),
      task('finished','P0','2026-10-20',{completed:true,completedDate:'2026-10-20'}),
      task('deleted','P0','2026-10-20',{deletedAt:'2026-10-19T00:00:00Z'}),
      task('medium-only','P1','2026-10-20'), task('low-only','P2','2026-10-21'),
      task('other-day-due','P0','2026-10-23',{dueDate:'2026-10-21'}),
      task('done-only','P0','2026-10-22',{completed:true,completedDate:'2026-10-22'})];
    const runtime:Runtime={state:{tasks,projects:[],conversations:[],sources:[],knowledge:[],skills:[],mcpServers:[],grants:[],plugins:[],drafts:[],schedules:[],runs:[],gitAccount:null,defaultModel:null,dataDirectory:'',appVersion:'test'},call:async()=>{throw new Error('No IPC in SSR');},refresh:async()=>{},report:()=>{},go:()=>{},openChat:()=>{},browseProject:()=>{}};
    const summary = (date:string) => {
      const html=renderToStaticMarkup(createElement(RuntimeContext.Provider,{value:runtime},createElement(Calendar,{date:'2026-10-19',onDate:()=>{}})));
      const cells=new Map([...html.matchAll(/<button[^>]*class="[^"]*\bday [^"]*"[^>]*aria-label="(\d{4}-\d{2}-\d{2})[^>]*>([\s\S]*?)<\/button>/g)].map(match=>[match[1],match[2]]));
      const marker=cells.get(date)!.match(/<span class="pending-count"([^>]*)>([\s\S]*?)<\/span>/);
      return marker ? {priority:marker[1].match(/data-pending-priority="([^"]+)"/)?.[1],count:marker[2].replace(/<[^>]*>/g,'').trim()} : null;
    };
    expect(summary('2026-10-19')).toEqual({priority:'P0',count:'3'});
    expect(summary('2026-10-20')).toEqual({priority:'P1',count:'1'});
    expect(summary('2026-10-21')).toEqual({priority:'P2',count:'1'});
    expect(summary('2026-10-22')).toBeNull();
    tasks.find(t=>t.id==='high')!.completed=true;
    expect(summary('2026-10-19')).toEqual({priority:'P1',count:'2'});
    tasks.find(t=>t.id==='medium')!.deletedAt='2026-10-19T01:00:00Z';
    expect(summary('2026-10-19')).toEqual({priority:'P2',count:'1'});
    tasks.find(t=>t.id==='low')!.priority='P0';
    expect(summary('2026-10-19')).toEqual({priority:'P0',count:'1'});
    tasks.find(t=>t.id==='low')!.completed=true;
    expect(summary('2026-10-19')).toBeNull();
  });
  it('renders one alarm count per execution day independently of task counts and names',()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const schedule:Schedule={id:'biweekly',name:'双周报完整名称',version:1,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',prompt:'test',projectId:null,model:{sourceId:'fixture',modelId:'fixture'},context:emptyContext(),spec:{kind:'biweekly',startDate:'2026-10-09',time:'09:00',timezone:'Asia/Shanghai'},enabled:true,status:'active',pauseReason:null,nextRunAt:'2026-10-09T01:00:00Z',nextSlot:null,sourceVersion:1};
    const runtime:Runtime={state:{tasks:[],projects:[],conversations:[],sources:[],knowledge:[],skills:[],mcpServers:[],grants:[],plugins:[],drafts:[],schedules:[schedule,{...schedule,id:'second'},{...schedule,id:'paused',enabled:false,status:'paused'}],runs:[],gitAccount:null,defaultModel:null,dataDirectory:'',appVersion:'test'},call:async()=>{throw new Error('no IPC in SSR');},refresh:async()=>{},report:()=>{},go:()=>{},openChat:()=>{},browseProject:()=>{}};
    const html=renderToStaticMarkup(createElement(RuntimeContext.Provider,{value:runtime},createElement(Calendar,{date:'2026-10-09',onDate:()=>{}})));
    const cells=[...html.matchAll(/<button[^>]*class="[^"]*\bday [^"]*"[^>]*aria-label="(\d{4}-\d{2}-\d{2})[^>]*>([\s\S]*?)<\/button>/g)];
    const dates=cells.filter(cell=>cell[2].includes('class="schedule-count"')).map(cell=>{expect(cell[2]).toContain('aria-label="定时任务 2 项"');expect(cell[2]).toContain('lucide-alarm-clock');expect(cell[2]).not.toContain('pending-count');return cell[1];});
    expect(dates).toEqual(['2026-10-09','2026-10-23','2026-11-06']);expect(html).not.toContain('双周报完整名称');
  });
  it('shows icon counts, hides zeroes and only flags unfinished tasks past their deadline', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 14, 12));
    const task = (id: string, date: string, completed: boolean, dueDate: string | null = null, deletedAt: string | null = null): Task => ({
      id, priority:'P2', title:`私密任务 ${id}`, notes:'', date, dueDate, completed, completedDate:completed?date:null, deletedAt, projectId:null,
      version:1, createdAt:'2026-10-01T00:00:00Z', updatedAt:'2026-10-01T00:00:00Z'
    });
    const tasks = [
      task('no-deadline', '2026-10-14', false), task('overdue', '2026-10-14', false, '2026-10-13'),
      task('due-today', '2026-10-14', false, '2026-10-14'), task('due-later', '2026-10-14', false, '2026-10-15'),
      task('completed-past-deadline', '2026-10-14', true, '2026-10-13'),
      task('d', '2026-10-15', false), task('e', '2026-10-16', true),
      task('previous-month-deadline', '2026-11-20', false, '2026-09-30'),
      task('next-month-deadline', '2026-12-20', false, '2026-11-01'),
      task('same-deadline', '2026-12-21', false, '2026-11-01'),
      task('deleted-pending', '2026-10-14', false, '2026-10-13', '2026-10-14T00:00:00Z'),
      task('deleted-done', '2026-10-14', true, '2026-10-13', '2026-10-14T00:00:00Z')
    ];
    const runtime: Runtime = {
      state: {tasks, projects:[], conversations:[], sources:[], knowledge:[], skills:[], mcpServers:[], grants:[], plugins:[], drafts:[], schedules:[], runs:[], gitAccount:null,defaultModel:null, dataDirectory:'', appVersion:'test'},
      call: async () => {throw new Error('Server rendering must not query holidays');},
      refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {}
    };
    const html = renderToStaticMarkup(createElement(RuntimeContext.Provider, {value:runtime}, createElement(Calendar, {date:'2026-10-14', onDate:()=>{}})));
    const cells = new Map([...html.matchAll(/<button[^>]*class="[^"]*\bday [^"]*"[^>]*aria-label="(\d{4}-\d{2}-\d{2})[^>]*>([\s\S]*?)<\/button>/g)].map(match => [match[1], match[2]]));
    const summaries = (date: string) => [...cells.get(date)!.matchAll(/<span class="((?:pending|done|overdue)-count)"([^>]*)>([\s\S]*?)<\/span>/g)].map(match => {
      const label = match[2].match(/aria-label="([^"]+)"/)?.[1];

      expect(match[3]).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(match[3]).toContain(`lucide-${{'pending-count':'circle', 'done-count':'check', 'overdue-count':'triangle-alert'}[match[1]]}`);
      return {label, text:match[3].replace(/<[^>]*>/g, '').trim()};
    });
    expect(summaries('2026-10-14')).toEqual([
      {label:'待办 4 项', text:'4'}, {label:'已完成 1 项', text:'1'}, {label:'逾期 1 项（包含在待办中）', text:'1'}
    ]);
    expect(summaries('2026-10-15')).toEqual([{label:'待办 1 项', text:'1'}]);
    expect(summaries('2026-10-16')).toEqual([{label:'已完成 1 项', text:'1'}]);
    expect(summaries('2026-10-17')).toEqual([]);
    const markers = [...cells].flatMap(([date, cell]) => {
      const marker = cell.match(/<span class="deadline-mark" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/span>/);
      if (!marker) return [];
      expect(marker[2]).toContain('lucide-calendar-clock');
      expect(marker[2].replace(/<[^>]*>/g, '').trim()).toBe('');
      return [[date, marker[1]]];
    });
    expect(markers).toEqual([
      ['2026-09-30', '本日截止 1 项'], ['2026-10-13', '本日截止 1 项'],
      ['2026-10-14', '本日截止 1 项'], ['2026-10-15', '本日截止 1 项'],
      ['2026-11-01', '本日截止 2 项']
    ]);
    expect(summaries('2026-09-30')).toEqual([]);
    expect(summaries('2026-11-01')).toEqual([]);
    expect(html).not.toContain('私密任务');
    expect(html).not.toContain('class="more"');
  });
});

describe('Sunday-first month grid', () => {
  it('places October 1, 2026 in the fifth column after the September 27 Sunday', () => {
    const days = monthDays(new Date(2026, 9, 1, 12));
    expect(localDate(days[0])).toBe('2026-09-27');
    expect(localDate(days[4])).toBe('2026-10-01');
    expect(days[4].getDay()).toBe(4);
  });

  it('does not add an empty leading week when the first day is Sunday', () => {
    const days = monthDays(new Date(2026, 1, 1, 12));
    expect(localDate(days[0])).toBe('2026-02-01');
    expect(localDate(days.at(-1)!)).toBe('2026-03-14');
    expect(days).toHaveLength(42);
  });

  it('includes leap day exactly once and excludes it in a non-leap February', () => {
    expect(monthDays(new Date(2024, 1, 1, 12)).filter(day => localDate(day) === '2024-02-29')).toHaveLength(1);
    expect(monthDays(new Date(2025, 1, 1, 12)).filter(day => day.getMonth() === 1)).toHaveLength(28);
  });

  it('keeps both visible years in a January grid without shifting local dates', () => {
    const days = monthDays(new Date(2026, 0, 1, 12));
    expect(localDate(days[0])).toBe('2025-12-28');
    expect(localDate(days.at(-1)!)).toBe('2026-02-07');
    expect([...new Set(days.map(day => day.getFullYear()))]).toEqual([2025, 2026]);
  });

  it('uses six complete weeks for August 2026 with continuous local noon dates', () => {
    const days = monthDays(new Date(2026, 7, 1, 12));
    expect(days).toHaveLength(42);
    expect(localDate(days[0])).toBe('2026-07-26');
    expect(localDate(days.at(-1)!)).toBe('2026-09-05');
    for (let index = 1; index < days.length; index++) {
      const nextDate = new Date(days[index - 1]);
      nextDate.setDate(nextDate.getDate() + 1);
      expect(days[index].getTime()).toBe(nextDate.getTime());
      expect(days[index].getHours()).toBe(12);
    }
  });

  it.each([[2026, 2], [2027, 5], [2027, 6]])('keeps six rows for %i-%i regardless of the weeks occupied by that month', (year, month) => {
    const days = monthDays(new Date(year, month - 1, 1, 12));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0);
    expect(days.at(-1)!.getDay()).toBe(6);
    expect(days.filter(day => day.getMonth() === month - 1)).toHaveLength(new Date(year, month, 0).getDate());
  });

  it('marks Sunday and Saturday as weekends while leaving Monday a weekday', () => {
    const runtime: Runtime = {
      state: {tasks:[], projects:[], conversations:[], sources:[], knowledge:[], skills:[], mcpServers:[], grants:[], plugins:[], drafts:[], schedules:[], runs:[], gitAccount:null,defaultModel:null, dataDirectory:'', appVersion:'test'},
      call: async () => {throw new Error('Server rendering must not query holidays');},
      refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {}
    };
    const html = renderToStaticMarkup(createElement(RuntimeContext.Provider, {value:runtime}, createElement(Calendar, {date:'2026-10-12', onDate:()=>{}})));
    const cells = new Map([...html.matchAll(/<button[^>]*class="[^"]*\bday ([^"]*)"[^>]*aria-label="(\d{4}-\d{2}-\d{2})/g)].map(match => [match[2],match[1]]));
    expect(cells.get('2026-10-04')).toContain('weekend');
    expect(cells.get('2026-10-03')).toContain('weekend');
    expect(cells.get('2026-10-05')).not.toContain('weekend');
    const headings = html.match(/<div class="weekdays">([\s\S]*?)<\/div>/)![1].replace(/<[^>]*>/g,'').replace(/\s/g,'');
    expect(headings).toBe('日一二三四五六');
    expect(html).toMatch(/class="[^"]*calendar-refresh[^"]*"[^>]*aria-label="刷新日历"/);
    expect(html).not.toMatch(/holiday-panel|国务院节假日安排|官方原文/);
    expect(html.match(/class="lunar-date(?: solar-term)?(?: festival)?"/g)).toHaveLength(42);
    expect(html.match(/class="lunar-date solar-term"/g)).toHaveLength(3);
    expect(html).toContain('class="lunar-date solar-term" aria-hidden="true">寒露</span>');
    expect(html).toContain('class="lunar-date solar-term" aria-hidden="true">霜降</span>');
    expect(html).toContain('2026-10-23，农历丙午年九月十四，霜降，0项未完成');
    expect(html).toContain('aria-label="2026-10-13，农历丙午年九月初四，');
    expect(html).toContain('2026-10-13，农历丙午年九月初四，0项未完成');
    expect(html).toContain('class="lunar-date festival" aria-hidden="true">重阳节</span>');
    expect(html).toContain('aria-label="2026-10-18，农历丙午年九月初九，重阳节，');
    expect(html).toContain('2026-10-18，农历丙午年九月初九，重阳节，0项未完成');
  });
});

describe('selected calendar festivals', () => {
  const annotation = (date: string) => calendarAnnotation(new Date(`${date}T12:00:00`));
  it.each([
    ['2026-02-17', '春节'], ['2026-03-03', '元宵节'], ['2026-03-20', '龙抬头'],
    ['2026-04-05', '清明节'], ['2026-06-19', '端午节'], ['2026-08-19', '七夕'],
    ['2026-08-27', '中元节'], ['2026-09-25', '中秋节'], ['2026-10-18', '重阳节'],
    ['2027-01-15', '腊八节'], ['2027-01-30', '北方小年'], ['2027-01-31', '南方小年'],
    ['2026-01-01', '元旦'], ['2026-05-01', '劳动节'], ['2026-06-01', '儿童节'], ['2026-10-01', '国庆节'],
    ['2026-02-14', '情人节'], ['2026-10-31', '万圣节'], ['2026-12-24', '平安夜'], ['2026-12-25', '圣诞节']
  ])('includes the curated festival on %s', (date, name) => {
    expect(annotation(date).festivals).toContain(name);
  });

  it('recognizes both a 29-day and a 30-day lunar New Year eve', () => {
    expect(annotation('2026-02-16').festivals).toEqual(['除夕']);
    expect(annotation('2024-02-09').festivals).toEqual(['除夕']);
    expect(annotation('2024-02-08').festivals).not.toContain('除夕');
    expect(annotation('2026-02-15').festivals).not.toContain('除夕');
  });

  it('does not repeat lunar festivals in leap months', () => {
    expect(annotation('2023-02-21').festivals).toContain('龙抬头');
    expect(annotation('2023-03-23').festivals).not.toContain('龙抬头');
    for (const day of ['2025-07-25', '2025-08-22']) expect(annotation(day).festivals).toEqual([]);
  });

  it.each([
    ['2025-05-11', '母亲节'], ['2026-05-10', '母亲节'], ['2027-05-09', '母亲节'],
    ['2025-06-15', '父亲节'], ['2026-06-21', '父亲节'], ['2027-06-20', '父亲节'],
    ['2025-11-27', '感恩节（美国）'], ['2026-11-26', '感恩节（美国）'], ['2027-11-25', '感恩节（美国）']
  ])('places the weekday-based festival on %s only', (date, name) => {
    const day = new Date(`${date}T12:00:00`);
    expect(calendarAnnotation(day).festivals).toContain(name);
    for (const offset of [-7, -1, 1, 7]) {
      const other = new Date(day);
      other.setDate(day.getDate() + offset);
      expect(calendarAnnotation(other).festivals).not.toContain(name);
    }
  });

  it('keeps simultaneous festivals and solar terms without repeating Qingming', () => {
    expect(annotation('2020-10-01').label).toBe('中秋节 · 国庆节');
    expect(annotation('2026-06-21').label).toBe('父亲节 · 夏至');
    expect(annotation('2026-03-20').label).toBe('龙抬头 · 春分');
    expect(annotation('2026-04-05').label).toBe('清明节');
    expect(annotation('2026-10-13').label).toBe('');
  });

  it('keeps simultaneous names and the full lunar date in accessible cell descriptions', () => {
    const runtime: Runtime = {
      state: {tasks:[], projects:[], conversations:[], sources:[], knowledge:[], skills:[], mcpServers:[], grants:[], plugins:[], drafts:[], schedules:[], runs:[], gitAccount:null,defaultModel:null, dataDirectory:'', appVersion:'test'},
      call: async () => {throw new Error('Server rendering must not query holidays');},
      refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {}
    };
    const html = renderToStaticMarkup(createElement(RuntimeContext.Provider, {value:runtime}, createElement(Calendar, {date:'2026-06-21', onDate:()=>{}})));
    expect(html).toContain('class="lunar-date solar-term festival" aria-hidden="true">父亲节 · 夏至</span>');
    expect(html).toContain('aria-label="2026-06-21，农历丙午年五月初七，父亲节 · 夏至，');
    expect(html).toContain('2026-06-21，农历丙午年五月初七，父亲节 · 夏至，0项未完成');
  });
});

describe('lunar calendar labels', () => {
  it.each([
    ['2026-02-16', '廿九', '农历乙巳年腊月廿九'],
    ['2026-02-17', '正月', '农历丙午年正月初一'],
    ['2026-02-18', '初二', '农历丙午年正月初二'],
    ['2026-03-18', '三十', '农历丙午年正月三十'],
    ['2026-03-19', '二月', '农历丙午年二月初一'],
    ['2025-07-25', '闰六月', '农历乙巳年闰六月初一'],
    ['2025-08-23', '七月', '农历乙巳年七月初一'],
    ['2026-10-13', '初四', '农历丙午年九月初四']
  ])('formats the civil date %s with its lunar month and day', (date, label, full) => {
    expect(lunarDate(new Date(`${date}T12:00:00`))).toEqual({label, full});
  });
});

describe('Beijing-date solar terms', () => {
  // Official UTC+8 dates: https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T2026c.txt
  const expected2026 = [
    ['01-05', '小寒'], ['01-20', '大寒'], ['02-04', '立春'], ['02-18', '雨水'],
    ['03-05', '惊蛰'], ['03-20', '春分'], ['04-05', '清明'], ['04-20', '谷雨'],
    ['05-05', '立夏'], ['05-21', '小满'], ['06-05', '芒种'], ['06-21', '夏至'],
    ['07-07', '小暑'], ['07-23', '大暑'], ['08-07', '立秋'], ['08-23', '处暑'],
    ['09-07', '白露'], ['09-23', '秋分'], ['10-08', '寒露'], ['10-23', '霜降'],
    ['11-07', '立冬'], ['11-22', '小雪'], ['12-07', '大雪'], ['12-22', '冬至']
  ];
  it('matches all 24 official 2026 dates and leaves every other day unmarked', () => {
    const actual: string[][] = [];
    for (const day = new Date(2026, 0, 1, 12); day.getFullYear() === 2026; day.setDate(day.getDate() + 1)) {
      const term = solarTerm(day);
      if (term) actual.push([localDate(day).slice(5), term]);
    }
    expect(actual).toEqual(expected2026);
  });
  it('keeps the near-midnight 2021 winter solstice on December 21', () => {
    // HKO: 2021-12-21 23:59 UTC+8; https://www.hko.gov.hk/tc/gts/astron2021/files/2021SolarTerms24.pdf
    expect(solarTerm(new Date(2021, 11, 21, 0))).toBe('冬至');
    expect(solarTerm(new Date(2021, 11, 21, 23, 59))).toBe('冬至');
    expect(solarTerm(new Date(2021, 11, 22, 12))).toBe('');
  });
  it('keeps terms in adjacent-year and leap-February grid cells', () => {
    expect(monthDays(new Date(2026, 11, 1, 12)).filter(day => solarTerm(day)).map(day => [localDate(day), solarTerm(day)]))
      .toEqual([['2026-12-07', '大雪'], ['2026-12-22', '冬至'], ['2027-01-05', '小寒']]);
    expect(solarTerm(new Date(2024, 1, 29, 12))).toBe('');
    expect(solarTerm(new Date(2027, 0, 5, 12))).toBe('小寒');
  });
});
