import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/renderer/calendar';
import { WorkDayProvider } from '../src/renderer/component-theme';
import { RuntimeContext, type Runtime } from '../src/renderer/ui';
import type { MeetingsResult } from '../src/shared/types';

function render(status: MeetingsResult['status'], loading = false) {
  const runtime: Runtime = { state: { tasks: [], projects: [], conversations: [], sources: [], knowledge: [], skills: [], mcpServers: [], grants: [], plugins: [], drafts: [], schedules: [], runs: [], gitAccount: null, defaultModel: null, dataDirectory: '', appVersion: 'test' }, call: async () => { throw new Error('SSR must not query'); }, refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {} };
  const meetings: MeetingsResult = { startDate: '2026-09-27', endDate: '2026-11-08', timezone: 'Asia/Shanghai', status, message: status === 'ready' ? null : '合成连接状态', meetings: [] };
  return renderToStaticMarkup(createElement(WorkDayProvider, { appearance: 'mono', children: createElement(RuntimeContext.Provider, { value: runtime }, createElement(Calendar, { date: '2026-10-15', onDate: () => {}, meetings, meetingsLoading: loading, onMeetingsRefresh: async () => {} })) }));
}

describe('month heading calendar connection control', () => {
  it.each([
    ['notDetermined', '连接钉钉日历'],
    ['ready', '同步钉钉日历'],
    ['denied', '重试同步钉钉日历'],
    ['error', '重试同步钉钉日历'],
  ] as const)('keeps %s control after refresh in the month heading', (status, label) => {
    const html = render(status);
    const title = html.slice(html.indexOf('class="calendar-title"'), html.indexOf('class="actions"'));
    const refresh = title.indexOf('aria-label="刷新日历"');
    expect(refresh).toBeGreaterThan(0);
    expect(title.indexOf(`aria-label="${label}"`)).toBeGreaterThan(refresh);
    expect(title).toContain(`data-state="${status}"`);
    if (status !== 'ready') expect(title).toContain('合成连接状态');
  });
  it('disables the control during synchronization', () => {
    const html = render('ready', true);
    const control = html.match(/<button[^>]*aria-label="正在同步钉钉日历"[^>]*>/)?.[0];
    expect(control).toBeDefined();
    expect(control).toContain('disabled');
    expect(control).toContain('aria-busy="true"');
  });
  it('keeps unsupported platform information accessible without offering an unusable action', () => {
    const html = render('unsupported');
    const control = html.match(/<button[^>]*aria-label="钉钉日历不可用"[^>]*>/)?.[0];
    expect(control).toBeDefined();
    expect(control).toContain('disabled');
    expect(html).toContain('合成连接状态');
  });
});
