import { describe, expect, it, vi } from 'vitest';
import type { WeatherLocation, WeatherPreference } from '../src/shared/types';
import { WEATHER_KEY, parseWeatherPreference, readWeatherPreference, saveWeatherPreference, weatherArtKind, weatherCondition } from '../src/renderer/weather-preference';

const location: WeatherLocation = { name: '杭州', country: '中国', region: '浙江', latitude: 30.2936, longitude: 120.1614, timezone: 'Asia/Shanghai' };
const manual: WeatherPreference = { mode: 'manual', location };

describe('local weather preferences', () => {
  it('persists a manual city, reloads it, and restores automatic mode without changing appearance', () => {
    const data = new Map([['workday.appearance', 'previous appearance']]);
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    saveWeatherPreference(storage, manual);
    expect(readWeatherPreference(storage)).toEqual(manual);
    saveWeatherPreference(storage, { mode: 'auto' });
    expect(readWeatherPreference(storage)).toEqual({ mode: 'auto' });
    expect(data.get('workday.appearance')).toBe('previous appearance');
    expect([...data.keys()]).toEqual(['workday.appearance', WEATHER_KEY]);
  });

  it.each([null, '{invalid', '[]', '{}', '{"mode":"unknown"}', '{"mode":"manual"}', '{"mode":"auto","location":null}'])('falls back to automatic mode for missing or corrupt stored data: %s', stored => {
    expect(readWeatherPreference({ getItem: () => stored })).toEqual({ mode: 'auto' });
  });

  it('falls back when storage is inaccessible', () => {
    expect(readWeatherPreference({ getItem: () => { throw new Error('SecurityError'); } })).toEqual({ mode: 'auto' });
  });

  it.each([
    { mode: 'manual', location, extra: true },
    { mode: 'manual', location: [] },
    ...Object.keys(location).filter(key => key !== 'region').map(key => ({ mode: 'manual', location: Object.fromEntries(Object.entries(location).filter(([field]) => field !== key)) })),
    ...[
      { extra: true }, { name: '' }, { country: ' ' }, { name: 'x'.repeat(121) }, { region: '' },
      { region: undefined }, { region: '浙江\n杭州' }, { latitude: 90.01 }, { latitude: -90.01 },
      { longitude: 180.01 }, { longitude: -180.01 }, { latitude: Infinity }, { longitude: NaN },
      { latitude: '30' }, { timezone: '' }, { timezone: 'Asia/Missing_City' }, { timezone: '+08:00' },
      { timezone: 'CST' }, { timezone: 'Asia/Shanghai\n' }
    ].map(patch => ({ mode: 'manual', location: { ...location, ...patch } }))
  ])('rejects incomplete or invalid preferences: %j', value => {
    expect(parseWeatherPreference(value)).toBeNull();
  });

  it('accepts valid coordinate boundaries and an optional region, retaining complete normalized fields', () => {
    const { region, ...withoutRegion } = location;
    expect(parseWeatherPreference({ mode: 'manual', location: { ...withoutRegion, name: ' 杭州 ', latitude: -90, longitude: 180, timezone: 'UTC' } })).toEqual({ mode: 'manual', location: { ...withoutRegion, latitude: -90, longitude: 180, timezone: 'UTC' } });
    expect(parseWeatherPreference({ mode: 'manual', location: { ...location, latitude: 90, longitude: -180 } })).not.toBeNull();
  });

  it('keeps the original city after quota failure and prevents invalid writes', () => {
    const previous = JSON.stringify(manual);
    const storage = { getItem: () => previous, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => saveWeatherPreference(storage, { mode: 'auto' })).toThrow('原设置保留');
    expect(readWeatherPreference(storage)).toEqual(manual);
    const setItem = vi.fn();
    expect(() => saveWeatherPreference({ setItem }, { mode: 'manual', location: { ...location, latitude: NaN } })).toThrow('无效');
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('WMO weather labels', () => {
  it.each([[0, '晴'], [3, '阴'], [48, '雾凇'], [57, '强冻毛毛雨'], [65, '大雨'], [67, '强冻雨'], [77, '雪粒'], [82, '强阵雨'], [86, '强阵雪'], [97, '强雷暴'], [99, '强雷暴伴冰雹']])('maps condition %s to %s', (code, label) => {
    expect(weatherCondition(code as number)).toBe(label);
  });

  it.each([-1, 4, 100, NaN, Infinity])('does not label an unknown condition as clear sky: %s', code => {
    expect(weatherCondition(code)).toBe('未知天气');
  });
});

describe('weather illustration selection', () => {
  it.each([
    ['clear', [0]], ['partly-cloudy', [1, 2]], ['overcast', [3]], ['fog', [45, 48]],
    ['drizzle', [51, 53, 55]], ['rain', [61, 63, 65, 80, 81, 82]],
    ['snow', [71, 73, 75, 77, 85, 86]], ['sleet', [56, 57, 66, 67]],
    ['thunderstorm', [95, 96, 97, 99]]
  ] as const)('uses %s artwork for the corresponding WMO conditions', (art, codes) => {
    for (const code of codes) {
      expect(weatherArtKind(code)).toBe(art);
      expect(weatherCondition(code)).not.toBe('未知天气');
    }
  });

  it.each([undefined, null, -1, 4, 100, 0.5, NaN, Infinity])('does not show misleading artwork for missing or unknown weather: %s', code => {
    expect(weatherArtKind(code)).toBeNull();
  });
});
