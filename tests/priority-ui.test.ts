import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayTasks } from '../src/renderer/calendar';
import { WorkDayProvider } from '../src/renderer/component-theme';
import { getTheme, themes, themeVariables } from '../src/renderer/theme';
import { RuntimeContext, type Runtime } from '../src/renderer/ui';
import type { Task } from '../src/shared/types';

const date = '2027-05-15';
function render(priority: Task['priority'] = 'P2', completed = false) {
  const task: Task = { id: 'priority', version: 1, createdAt: '', updatedAt: '', title: '合成优先级事项', notes: '', date, dueDate: date, priority, projectId: null, completed, completedDate: completed ? date : null, deletedAt: null };
  const runtime: Runtime = { state: { tasks: [task], projects: [], conversations: [], sources: [], knowledge: [], skills: [], mcpServers: [], grants: [], plugins: [], drafts: [], schedules: [], runs: [], gitAccount: null, defaultModel: null, dataDirectory: '', appVersion: 'test' }, call: async () => { throw new Error('SSR must not query'); }, refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {} };
  return renderToStaticMarkup(createElement(WorkDayProvider, { appearance: 'mono', children: createElement(RuntimeContext.Provider, { value: runtime }, createElement(DayTasks, { date, weatherPreference: { mode: 'auto' } })) }));
}
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

describe('task priority controls', () => {
  it.each(['P0', 'P1', 'P2'] as const)('shows %s as an accessible compact menu between deadline and project', priority => {
    const html = render(priority);
    expect(html).toContain(`aria-label="优先级 合成优先级事项：${priority}"`);
    expect(html).toContain(`data-priority="${priority}"`);
    const actions = html.slice(html.indexOf('class="task-actions"'));
    expect(actions.indexOf('class="task-deadline')).toBeLessThan(actions.indexOf('task-priority-picker'));
    expect(actions.indexOf('task-priority-picker')).toBeLessThan(actions.indexOf('task-project-picker'));
    expect(actions.indexOf('task-project-picker')).toBeLessThan(actions.indexOf('编辑与改期'));
    expect(actions).toMatch(/<button[^>]*aria-label="优先级 合成优先级事项：P[012]"[^>]*aria-haspopup="menu"/);
  });
  it('uses P2 for a new task and keeps the control available on completed items', () => {
    expect(render()).toContain('aria-label="优先级 合成优先级事项：P2"');
    expect(render('P0', true)).toContain('aria-label="优先级 合成优先级事项：P0"');
  });
  it('provides readable red, yellow and blue priority tokens in every theme', () => {
    for (const { id } of themes) {
      const variables = themeVariables(getTheme(id));
      for (const priority of ['p0', 'p1', 'p2']) {
        const ink = variables[`--priority-${priority}-text`], background = variables[`--priority-${priority}-background`];
        expect(ink, `${id} ${priority} text`).toMatch(/^#[\da-f]{6}$/i);
        expect(background, `${id} ${priority} background`).toMatch(/^#[\da-f]{6}$/i);
        const values = [luminance(ink), luminance(background)].sort((a, b) => b - a);
        expect((values[0] + .05) / (values[1] + .05), `${id} ${priority} contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
