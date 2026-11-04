import { Button, TextInput } from '@mantine/core';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { WeatherLocation, WeatherPreference, WeatherResult } from '../../shared/types';
import { Hint, useApp } from '../shared/ui';
import { locationLabel, weatherArtKind, weatherCondition } from './weather-preference';
import { weatherArt } from './weather-art';

type WeatherView = { key: string; result: WeatherResult | null; error: string; loading: boolean };

export function useWeather(date: string, preference: WeatherPreference) {
  const { call } = useApp();
  const callRef = useRef(call);
  callRef.current = call;
  const [refresh, setRefresh] = useState(0);
  const refreshRequested = useRef(false);
  const [view, setView] = useState<WeatherView | null>(null);
  const location = preference.mode === 'manual' ? preference.location : null;
  const key = JSON.stringify([date, location, refresh]);
  useEffect(() => {
    let current = true;
    const force = refreshRequested.current;
    refreshRequested.current = false;
    setView({ key, result: null, error: '', loading: true });
    void callRef.current('weather.query', { date, location, ...(force ? { refresh: true } : {}) }).then(result => {
      if (result.status === 'ready' && (
        !result.location || !result.day || result.day.date !== date ||
        !Number.isFinite(result.day.temperatureMin) || !Number.isFinite(result.day.temperatureMax) ||
        result.day.temperatureMin > result.day.temperatureMax
      )) {
        throw new Error('所选日期天气数据无效，请重试。');
      }
      if (current) setView({ key, result, error: '', loading: false });
    }).catch(error => {
      if (current) setView({ key, result: null, error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { current = false; };
  }, [key]);
  // Key matching also hides the old date's values before the next effect starts.
  const active = view?.key === key ? view : null;
  const loading = !active || active.loading;
  const result = active?.result;
  const day = result?.status === 'ready' ? result.day : null;
  const city = result?.location ?? location;
  const cityName = city?.name ?? (loading ? '自动定位中…' : 'IP 自动定位');
  const condition = day ? weatherCondition(day.code) : loading ? '天气加载中…' : active?.error ? '天气获取失败' : '该日期暂无天气';
  const artKind = weatherArtKind(day?.code);
  const temperature = day ? [day.temperatureMin, day.temperatureMax]
    .map(value => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })).join('–') + '℃' : '';
  const message = active?.error || result?.message || '';
  const summary = `${date}，${city ? locationLabel(city) : cityName}，${condition}${day ? `，最低 ${day.temperatureMin} 摄氏度，最高 ${day.temperatureMax} 摄氏度` : ''}${message ? `，${message}` : ''}`;
  const refreshWeather = useCallback((force = true) => {
    refreshRequested.current = force;
    setRefresh(value => value + 1);
  }, []);
  return { loading, failed: !!active?.error, status: result?.status, cityName, condition, artKind, temperature, message, summary, refreshWeather };
}

export function WeatherBlock({ date, preference }: {
  date: string;
  preference: WeatherPreference;
}) {
  const { loading, failed, status, cityName, condition, artKind, temperature, message, summary } = useWeather(date, preference);
  if (!temperature) return null;
  return <div className={`weather-block${artKind ? ' weather-with-art' : ''}`} data-weather-date={date} data-weather-state={loading ? 'loading' : failed ? 'error' : status}>
    {artKind && <img className="weather-art" data-weather-art={artKind} src={weatherArt[artKind]} alt="" aria-hidden="true" width={156} height={96} draggable={false} />}
    <Hint label={summary}><div tabIndex={0} className={`weather-copy ${failed ? 'weather-error' : ''}`} role="status" aria-live="polite" aria-busy={loading} aria-label={summary}>
      <strong className="weather-city">{cityName}</strong>
      <span className="weather-condition">{condition}</span>
      {temperature && <span className="weather-temperature">{temperature}</span>}
      {!temperature && message && <span className="weather-message">{message}</span>}
    </div></Hint>
  </div>;
}

export function WeatherSettings({ preference, onChange }: {
  preference: WeatherPreference;
  onChange: (value: WeatherPreference) => void;
}) {
  const { call } = useApp();
  const callRef = useRef(call);
  callRef.current = call;
  const sequence = useRef(0);
  const mounted = useRef(true);
  const [query, setQuery] = useState('');
  const [locations, setLocations] = useState<WeatherLocation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  async function search(event: FormEvent) {
    event.preventDefault();
    const request = ++sequence.current;
    setBusy(true);
    setLocations(null);
    setError('');
    setSaved('');
    try {
      const result = await callRef.current('weather.search', { query: query.trim() });
      if (mounted.current && request === sequence.current) setLocations(result);
    } catch (failure) {
      if (mounted.current && request === sequence.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current && request === sequence.current) setBusy(false);
    }
  }
  function save(value: WeatherPreference) {
    setError('');
    setSaved('');
    try {
      onChange(value);
      setSaved(value.mode === 'auto' ? '已恢复 IP 自动定位。' : `天气城市已保存：${locationLabel(value.location)}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  return <div className="weather-settings">
    <div className="weather-preference">
      <div>
        <span className="muted">当前位置</span>
        <Hint label={preference.mode === 'manual' ? locationLabel(preference.location) : '根据网络出口 IP 近似定位；代理可能影响城市。'}><p tabIndex={0} className="weather-current">
          {preference.mode === 'manual' ? locationLabel(preference.location) : '自动定位'}
        </p></Hint>
      </div>
      <Button className="text-button" type="button" aria-label="恢复 IP 自动定位" disabled={preference.mode === 'auto'} onClick={() => save({ mode: 'auto' })}>恢复自动</Button>
    </div>
    <form className="weather-search" role="search" aria-label="天气城市搜索" onSubmit={event => void search(event)}>
      <TextInput aria-label="天气城市" required minLength={2} maxLength={80} value={query} placeholder="搜索城市，如杭州" autoComplete="off" onChange={event => {
        sequence.current++;
        setQuery(event.target.value);
        setLocations(null);
        setBusy(false);
        setError('');
        setSaved('');
      }} />
      <Button aria-label="搜索天气城市" disabled={query.trim().length < 2} type="submit">{busy ? '重新搜索' : '搜索'}</Button>
    </form>
    {busy && <p className="muted" role="status">正在搜索城市…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {saved && <p className="muted weather-saved" role="status">{saved}</p>}
    {locations && !locations.length && <p className="muted" role="status">没有匹配城市，请尝试其他名称。</p>}
    {!!locations?.length && <div className="weather-candidates">
      {locations?.map((candidate, index) => {
        const selected = preference.mode === 'manual' && JSON.stringify(preference.location) === JSON.stringify(candidate);
        const label = locationLabel(candidate);
        return <div className="weather-candidate" key={`${candidate.latitude}:${candidate.longitude}:${index}`}>
          <Hint label={label}><div tabIndex={0}>
            <strong>{candidate.name}</strong>
            <span>{[candidate.region, candidate.country].filter(Boolean).join(' · ')}</span>
          </div></Hint>
          <Button type="button" disabled={selected} aria-label={`使用天气城市 ${label}`} onClick={() => save({ mode: 'manual', location: candidate })}>
            {selected ? '已选择' : '选择'}
          </Button>
        </div>;
      })}
    </div>}
    <Hint label="自动定位使用网络出口 IP，代理可能影响城市。支持中英文搜索；天气显示摄氏最低与最高温度，超出支持范围的日期暂无数据。">
      <p tabIndex={0} className="muted weather-source-note">位置仅保存在本机 · 天气由 Open-Meteo 提供</p>
    </Hint>
  </div>;
}
