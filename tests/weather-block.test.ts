import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkDayProvider } from '../src/renderer/component-theme';
import { RuntimeContext, type Runtime } from '../src/renderer/ui';
import { WeatherBlock, WeatherSettings } from '../src/renderer/weather';
import type { WeatherPreference } from '../src/shared/types';

const city = { name: '合成城市', country: '中国', region: '合成地区', latitude: 30.3, longitude: 120.2, timezone: 'Asia/Shanghai' };
const preferences: WeatherPreference[] = [{ mode: 'auto' }, { mode: 'manual', location: city }];

function render(children: ReturnType<typeof createElement>) {
  const call = vi.fn(async () => { throw new Error('SSR must not query'); });
  const runtime: Runtime = {
    state: { tasks: [], projects: [], conversations: [], sources: [], knowledge: [], skills: [], mcpServers: [], grants: [], plugins: [], drafts: [], schedules: [], runs: [], gitAccount: null, defaultModel: null, dataDirectory: '', appVersion: 'test' },
    call: call as Runtime['call'], refresh: async () => {}, report: () => {}, go: () => {}, openChat: () => {}, browseProject: () => {},
  };
  const html = renderToStaticMarkup(createElement(WorkDayProvider, { appearance: 'mono', children: createElement(RuntimeContext.Provider, { value: runtime }, children) }));
  expect(call).not.toHaveBeenCalled();
  return html;
}

describe('day panel weather without a forecast', () => {
  it.each(preferences)('leaves the corner empty before a forecast arrives for $mode location', preference => {
    const html = render(createElement(WeatherBlock, { date: '2026-10-20', preference }));
    expect(html).not.toContain('weather-block');
    expect(html).not.toContain('weather-city');
    expect(html).not.toContain('weather-copy');
    expect(html).not.toMatch(/自动定位中|天气加载中|合成城市/);
  });

  it('keeps the location and search controls in weather settings', () => {
    const html = render(createElement(WeatherSettings, { preference: preferences[1], onChange: () => {} }));
    expect(html).toContain('手动城市：合成城市');
    expect(html).toContain('aria-label="搜索天气城市"');
    expect(html).toContain('aria-label="恢复 IP 自动定位"');
  });
});
