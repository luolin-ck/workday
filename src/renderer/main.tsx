import { ActionIcon, Button } from '@mantine/core';
import '@mantine/core/styles.css';
import { WorkDayProvider } from './component-theme';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppState, WeatherPreference } from '../shared/types';
import type { Operations } from '../shared/api';
import { RuntimeContext, Hint, localDate, type Page, type Call } from './ui';
import { Calendar, DayTasks } from './calendar';
import { Chat } from './chat';
import { Projects } from './projects';
import { KnowledgePage } from './knowledge';
import { Settings } from './settings';
import { Schedules } from './schedules';
import { PluginsPage } from './plugins';
import { Icon, type IconName } from './icons';
import { applyAppearance, defaultAppearance, readAppearance, saveAppearance, type AppearancePatch } from './appearance';
import { createAppearanceStorage } from './appearance-storage';
import { readWeatherPreference, saveWeatherPreference } from './weather-preference';
import { DailyBanner } from './daily-banner';
import { useMeetings } from './use-meetings';
import workdayLogo from '../../assets/branding/workday-logo.svg';
import './style.css';
const navigation: Page[] = ['Home', '项目', '定时任务', '知识库', '插件'];
const navIcons: Record<Page, IconName> = { Home: 'house', 项目: 'folders', 定时任务: 'alarm-clock', 知识库: 'library-big', 插件: 'puzzle', 设置: 'settings' };
function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('Home');
  const [selectedDate, setSelectedDate] = useState(localDate());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(`${localDate()}T12:00:00`));
  const [newChatProjectId, setNewChatProjectId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [appearance, setAppearance] = useState(defaultAppearance);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [appearanceReady, setAppearanceReady] = useState(false);
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  const [appearanceStorage] = useState(createAppearanceStorage);
  const appearanceOwner = useRef({ value: appearance, url: null as string | null, ready: false, active: true, pending: 0, queue: Promise.resolve() });
  useEffect(() => {
    const owner = appearanceOwner.current; owner.active = true;
    void readAppearance(appearanceStorage, {
      getItem: key => window.localStorage.getItem(key),
      removeItem: key => window.localStorage.removeItem(key)
    }).then(({ appearance: restored, error }) => {
      if (!owner.active) return;
      owner.value = restored;
      owner.url = restored.background ? URL.createObjectURL(restored.background) : null;
      owner.ready = true;
      setAppearance(restored); setBackgroundUrl(owner.url); setAppearanceReady(true);
      if (error) setNotice(error);
    }).catch(error => { if (owner.active) { owner.ready = true; setAppearanceReady(true); setNotice(String(error)); } });
    return () => { owner.active = false; if (owner.url) URL.revokeObjectURL(owner.url); };
  }, [appearanceStorage]);
  const [weatherPreference, setWeatherPreference] = useState<WeatherPreference>(() => {
    try { return readWeatherPreference(window.localStorage); }
    catch { return { mode: 'auto' }; }
  });
  const [settingsTab, setSettingsTab] = useState<'models' | 'weather' | 'links'>('models');
  const [startError, setStartError] = useState('');
  const sequence = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  useLayoutEffect(() => applyAppearance(document.documentElement, appearance, backgroundUrl), [appearance, backgroundUrl]);
  function changeAppearance(patch: AppearancePatch): Promise<void> {
    const owner = appearanceOwner.current;
    if (!owner.ready) return Promise.reject(new Error('外观设置正在载入，请稍候'));
    owner.pending++; setAppearanceBusy(true);
    const commit = owner.queue.then(async () => {
      const next = { ...owner.value, ...patch };
      const changedBackground = next.background !== owner.value.background;
      const nextUrl = changedBackground ? (next.background ? URL.createObjectURL(next.background) : null) : owner.url;
      try { await saveAppearance(appearanceStorage, next); }
      catch (error) { if (changedBackground && nextUrl) URL.revokeObjectURL(nextUrl); throw error; }
      if (!owner.active) { if (changedBackground && nextUrl) URL.revokeObjectURL(nextUrl); return; }
      const previousUrl = owner.url;
      owner.value = next; owner.url = nextUrl;
      // Apply before releasing the old URL so the active background never points at a revoked URL.
      applyAppearance(document.documentElement, next, nextUrl);
      setAppearance(next); setBackgroundUrl(nextUrl);
      if (changedBackground && previousUrl) URL.revokeObjectURL(previousUrl);
    });
    owner.queue = commit.catch(() => {});
    return commit.finally(() => { owner.pending--; if (owner.active) setAppearanceBusy(owner.pending > 0); });
  }
  function changeWeatherPreference(next: WeatherPreference) {
    saveWeatherPreference(window.localStorage, next);
    setWeatherPreference(next);
  }
  async function refresh() {
    const request = ++sequence.current;
    const result = await window.workday.call('state.get', {});
    if (!result.ok)
      throw new Error(result.error.message);
    if (request === sequence.current)
      setState(result.value);
  }
  const call: Call = async <K extends keyof Operations>(operation: K, payload: Operations[K]['input']): Promise<Operations[K]['output']> => {
    const result = await window.workday.call(operation, payload);
    if (!result.ok)
      throw new Error(`${result.error.message}（${result.error.code}）`);
    if (!['security.keychain.status', 'security.keychain.configure', 'security.keychain.open', 'state.get', 'weather.search', 'weather.query', 'meetings.query', 'holidays.query', 'holidays.openSource', 'conversations.history', 'components.session', 'components.readDraftFile', 'schedules.runs', 'mcp.call', 'mcp.readResource', 'data.backup', 'data.validate'].includes(operation))
      await refresh().catch(e => setNotice(`操作已提交，但刷新失败：${e.message}`));
    return result.value;
  };
  const meetings = useMeetings(localDate(calendarMonth), Boolean(state) && page === 'Home', call);
  useEffect(() => {
    if (!window.workday) {
      setStartError('未检测到桌面桥接。请通过 Electron 启动 WorkDay。');
      return;
    }
    void refresh().catch(e => setStartError(e.message));
    return window.workday.subscribe(event => {
      if (event.type === 'stateChanged')
        void refresh().catch(e => setNotice(e.message));
    });
  }, []);
  function go(next: Page, tab?: 'models' | 'weather' | 'links') {
    if (next === '设置') setSettingsTab(tab ?? 'models');
    setPage(next);
  }
  function openChat(id: string, knownProjectId?: string | null) {
    setChatId(id);
    const c = stateRef.current?.conversations.find(c => c.id === id);
    setProjectId(knownProjectId !== undefined ? knownProjectId : c?.projectId ?? null);
    go('项目');
  }
  function browseProject(id: string | null) {
    setProjectId(id);
    setChatId(null);
    go('项目');
  }
  if (!state)
    return <WorkDayProvider appearance={appearance.theme}><div className="startup">
      <img className="brand-mark" src={workdayLogo} alt="" aria-hidden="true" draggable={false} />
      <h1>
        WorkDay
      </h1>
      <p>
        {startError || '正在打开你的工作台…'}
      </p>
      {startError && <Button type="button" onClick={() => {
        setStartError('');
        void refresh().catch(e => setStartError(e.message));
      }}>
        重试
      </Button>}
    </div></WorkDayProvider>;
  const conversationPage = page === 'Home' || page === '项目';
  return <WorkDayProvider appearance={appearance.theme}><RuntimeContext.Provider value={{ state, call, refresh, report: setNotice, go, openChat, browseProject }}>
    <div className="app-shell">
      <header className="titlebar">
        <span className="wordmark">
          <img src={workdayLogo} alt="" aria-hidden="true" className="wordmark-logo" draggable={false} />
          WorkDay
        </span>
        <span className="title-divider" />
        <DailyBanner preference={weatherPreference} />
      </header>
      <nav className="navigation" aria-label="全局导航">
        <div className="nav-items">
          {navigation.map(item => <Hint label={item} position="right" key={item}><ActionIcon type="button" aria-label={item} aria-current={page === item ? 'page' : undefined} className={page === item ? 'active' : ''} key={item} onClick={() => go(item)}>
            <Icon name={navIcons[item]} size="nav" />
          </ActionIcon></Hint>)}
        </div>
        <Hint label="设置" position="right"><ActionIcon type="button" aria-label="设置" aria-current={page === '设置' ? 'page' : undefined} className={`settings-nav ${page === '设置' ? 'active' : ''}`} onClick={() => go('设置')}>
          <Icon name="settings" size="nav" />
        </ActionIcon></Hint>
      </nav>
      <main className={`workspace ${page === 'Home' ? 'home' : page === '项目' ? 'projects' : 'full'}`}>
        <div className="primary-area">
          {page === 'Home' && <Calendar date={selectedDate} onDate={setSelectedDate} month={calendarMonth} onMonth={setCalendarMonth} meetings={meetings.result} meetingsLoading={meetings.loading} onMeetingsRefresh={meetings.refresh} />}

          {page === '项目' && <Projects selected={projectId} onSelect={browseProject} activeChat={chatId} />}

          {page === '知识库' && <KnowledgePage />}

          {page === '设置' && <Settings appearance={appearance} backgroundUrl={backgroundUrl} appearanceDisabled={!appearanceReady || appearanceBusy} onAppearanceChange={changeAppearance} weatherPreference={weatherPreference} onWeatherChange={changeWeatherPreference} initialTab={settingsTab} />}

          {page === '定时任务' && <Schedules />}

          {page === '插件' && <PluginsPage />}
        </div>
        <aside className="conversation-column" hidden={!conversationPage}>
          <div className="daily-wrapper" hidden={page !== 'Home'}>
            <DayTasks date={selectedDate} weatherPreference={weatherPreference} meetings={meetings.result} meetingsLoading={meetings.loading} />
          </div>
          <Chat key={page === 'Home' ? 'home' : 'conversation'} conversationId={page === 'Home' ? null : chatId} newProjectId={page === 'Home' ? newChatProjectId : projectId} date={page === 'Home' ? selectedDate : null} newDate={page === 'Home' ? selectedDate : null} onProjectChange={page === 'Home' ? setNewChatProjectId : undefined} />
        </aside>
      </main>
      {notice && <div className="notification" role="alert">
        <span>
          {notice}
        </span>
        <ActionIcon type="button" aria-label="关闭提示" onClick={() => setNotice('')}>
          <Icon name="x" />
        </ActionIcon>
      </div>}
    </div>
  </RuntimeContext.Provider></WorkDayProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
