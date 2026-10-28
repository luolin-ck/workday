import type { WeatherLocation, WeatherPreference } from '../shared/types';

export const WEATHER_KEY = 'workday.weather';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch { return false; }
}

export function parseWeatherPreference(value: unknown): WeatherPreference | null {
  if (!object(value)) return null;
  if (value.mode === 'auto') return Object.keys(value).length === 1 ? { mode: 'auto' } : null;
  if (value.mode !== 'manual' || Object.keys(value).length !== 2 || !object(value.location)) return null;
  const location = value.location;
  if (Object.keys(location).some(key => !['name', 'country', 'region', 'latitude', 'longitude', 'timezone'].includes(key))) return null;
  if (!text(location.name) || !text(location.country) || ('region' in location && !text(location.region))) return null;
  if (typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90) return null;
  if (typeof location.longitude !== 'number' || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180 || !validTimezone(location.timezone)) return null;
  return {
    mode: 'manual',
    location: {
      name: location.name.trim(), country: location.country.trim(),
      ...(typeof location.region === 'string' ? { region: location.region.trim() } : {}),
      latitude: location.latitude, longitude: location.longitude, timezone: location.timezone
    }
  };
}

export function readWeatherPreference(storage: Pick<Storage, 'getItem'>): WeatherPreference {
  try { return parseWeatherPreference(JSON.parse(storage.getItem(WEATHER_KEY) ?? 'null')) ?? { mode: 'auto' }; }
  catch { return { mode: 'auto' }; }
}

export function saveWeatherPreference(storage: Pick<Storage, 'setItem'>, value: WeatherPreference) {
  const validated = parseWeatherPreference(value);
  if (!validated) throw new Error('天气位置设置无效，请重新选择城市。');
  try { storage.setItem(WEATHER_KEY, JSON.stringify(validated)); }
  catch { throw new Error('天气位置保存失败，请检查本机存储空间；原设置保留。'); }
}

export function locationLabel(location: WeatherLocation) {
  return [location.name, location.region, location.country].filter(Boolean).join(' · ');
}

// Open-Meteo WMO interpretation: https://open-meteo.com/en/docs#weather_variable_documentation
const conditions: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 56: '小冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '小冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴冰雹', 97: '强雷暴', 99: '强雷暴伴冰雹'
};

export function weatherCondition(code: number) {
  return conditions[code] ?? '未知天气';
}

export type WeatherArtKind = 'clear' | 'partly-cloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'sleet' | 'thunderstorm';

const conditionArt: Record<number, WeatherArtKind> = {
  0: 'clear', 1: 'partly-cloudy', 2: 'partly-cloudy', 3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  56: 'sleet', 57: 'sleet', 66: 'sleet', 67: 'sleet',
  61: 'rain', 63: 'rain', 65: 'rain', 80: 'rain', 81: 'rain', 82: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow', 85: 'snow', 86: 'snow',
  95: 'thunderstorm', 96: 'thunderstorm', 97: 'thunderstorm', 99: 'thunderstorm'
};

export function weatherArtKind(code: number | null | undefined): WeatherArtKind | null {
  return code == null ? null : conditionArt[code] ?? null;
}
