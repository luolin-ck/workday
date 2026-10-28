import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayTasks } from '../src/renderer/calendar';
import { WorkDayProvider } from '../src/renderer/component-theme';
import { RuntimeContext, type Runtime } from '../src/renderer/ui';
import type { MeetingsResult, Task } from '../src/shared/types';

const date = '2027-05-15';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, version: 1, createdAt: '', updatedAt: '', title: `合成事项 ${id}`, notes: '', date, dueDate: null, priority: 'P2', projectId: null, completed: false, completedDate: null, deletedAt: null, ...extra });
const ready: MeetingsResult = { startDate: '2027-05-01', endDate: '2027-06-01', timezone: 'Asia/Shanghai', status: 'ready', message: null, meetings: [{ id: 'meeting', title: '合成会议', start: `${date}T09:00:00+08:00`, end: `${date}T10:00:00+08:00`, allDay: false, startDate: null, endDate: null }] };
function render(tasks: Task[], meetings = ready, loading = false) {
  const runtime: Runtime = { state: { tasks, projects: [], conversations: [], sources: [], knowledge: [], skills: [], mcpServers: [], grants: [], plugins: [], drafts: [], schedules: [], runs: [], gitAccount: null, defaultModel: null, dataDirectory: '', appVersion: 'test' }, call: async () => { throw new Error('SSR must not query'); }, refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {} };
  return renderToStaticMarkup(createElement(WorkDayProvider, { appearance: 'mono', children: createElement(RuntimeContext.Provider, { value: runtime }, createElement(DayTasks, { date, weatherPreference: { mode: 'auto' }, meetings, meetingsLoading: loading })) }));
}
const headings = (html: string) => (html.match(/<h3\b[^>]*>.*?<\/h3>/g) ?? []).map(value => value.replace(/<[^>]+>/g, ''));

describe('selected day categories', () => {
  it('separates meetings and items, counting only the selected day including completed items', () => {
    const html = render([task('open'), task('done', { completed: true }), task('deleted', { deletedAt: '2027-05-15T00:00:00Z' }), task('other', { date: '2027-05-16' })]);
    expect(headings(html)).toEqual(['会议1', '事项2']);
    expect(html).toContain('aria-label="事项"');
    expect(html).not.toContain('合成事项 deleted');
    expect(html).not.toContain('合成事项 other');
    expect(html).toContain('aria-label="新增待办"');
  });
  it('hides the meetings category when the day has no meetings', () => {
    const html = render([], { ...ready, meetings: [] });
    expect(headings(html)).toEqual(['事项0']);
    expect(html).not.toContain('aria-label="钉钉会议"');
    expect(html).toMatch(/<img[^>]+alt="暂无待办"/);
    expect(html).not.toContain('>暂无待办<');
  });
  it('keeps the empty illustration inside items even when there are meetings', () => {
    const html = render([task('deleted', { deletedAt: '2027-05-15T00:00:00Z' }), task('other', { date: '2027-05-16' })]);
    expect(headings(html)).toEqual(['会议1', '事项0']);
    expect(html).toMatch(/<section class="day-group day-items"[\s\S]*<img[^>]+alt="暂无待办"/);
    expect(html).toContain('aria-label="新增待办"');
  });
  it.each([false, true])('keeps saved records instead of an empty illustration (completed: %s)', completed => {
    const html = render([task('visible', { completed })]);
    expect(html).not.toContain('alt="暂无待办"');
    expect(html).toContain('合成事项 visible');
  });
  it('hides meetings for the selected day even if another day has meetings', () => {
    const html = render([task('open')], { ...ready, meetings: ready.meetings.map(meeting => ({ ...meeting, start: '2027-05-16T09:00:00+08:00', end: '2027-05-16T10:00:00+08:00' })) });
    expect(headings(html)).toEqual(['事项1']);
    expect(html).not.toContain('aria-label="钉钉会议"');
  });
  it.each(['notDetermined', 'denied', 'error', 'unsupported'] as const)('hides the meetings category when calendar status is %s', status => {
    const html = render([task('open')], { ...ready, status, meetings: [], message: '合成日历状态' });
    expect(headings(html)).toEqual(['事项1']);
    expect(html).not.toContain('合成日历状态');
    expect(html).not.toContain('aria-label="钉钉会议"');
  });
  it('does not display stale meeting counts while loading', () => {
    const html = render([], ready, true);
    expect(headings(html)).toEqual(['事项0']);
    expect(html).not.toContain('正在同步会议');
    expect(html).not.toContain('合成会议');
  });
});
