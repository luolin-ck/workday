import { useEffect, useState } from 'react';
import type { WeatherPreference } from '../shared/types';
import { Hint, localDate, useApp } from './ui';
import { useWeather } from './weather';

const encouragements = ['专注今天，更好的明天', '一件一件来，每一步都算数', '认真向前，也记得休息', '小小的进展，也是值得肯定的进步'];

export function DailyBanner({ preference }: { preference: WeatherPreference }) {
  const { state } = useApp();
  const [today, setToday] = useState(localDate);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const weather = useWeather(today, preference);
  const { refreshWeather } = weather;

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = () => setReducedMotion(media.matches);
    const updateDate = () => setToday(localDate());
    const resume = () => {
      setVisible(!document.hidden);
      if (!document.hidden) { updateDate(); refreshWeather(false); }
    };
    const clock = window.setInterval(updateDate, 60_000);
    const forecast = window.setInterval(() => { if (!document.hidden) refreshWeather(false); }, 30 * 60_000);
    media.addEventListener('change', motionChanged);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      clearInterval(clock); clearInterval(forecast);
      media.removeEventListener('change', motionChanged);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [refreshWeather]);

  useEffect(() => {
    if (!visible || reducedMotion) return;
    const timer = window.setInterval(() => setStep(value => value + 1), 6000);
    return () => clearInterval(timer);
  }, [visible, reducedMotion]);

  const remaining = state.tasks.filter(task => task.date === today && !task.completed && !task.deletedAt).length;
  const tasks = remaining ? `今日还有 ${remaining} 项待办，慢慢来` : '今日剩余待办 0 项，留一点时间给自己';
  const forecast = weather.loading ? '今日天气加载中…' : weather.failed || weather.status !== 'ready'
    ? '今日天气暂不可用，稍后再看看'
    : `${weather.cityName}今日 · ${weather.condition} ${weather.temperature}`;
  const message = (index: number) => [forecast, tasks, encouragements[Math.floor(index / 3) % encouragements.length]][index % 3];
  const summary = `${today} · ${forecast} · ${tasks} · ${encouragements[Math.floor(step / 3) % encouragements.length]}`;

  return <div className="tagline">
    <Hint label={summary}><div tabIndex={0} className="tagline-readout" role="group" aria-label={summary} aria-live="off">
      {reducedMotion ? <span className="tagline-face" aria-hidden="true">{forecast} · {tasks}</span> : <span className="tagline-flip" key={step} aria-hidden="true">
        {step > 0 && <span className="tagline-face tagline-out">{message(step - 1)}</span>}
        <span className={`tagline-face tagline-current ${step > 0 ? 'tagline-in' : ''}`}>{message(step)}</span>
      </span>}
    </div></Hint>
  </div>;
}
