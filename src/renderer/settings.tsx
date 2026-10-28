import { customThemeFields, defaultCustomTheme, parseCustomTheme, previewVariables } from './theme';
import { ActionIcon, Button, Checkbox, NativeSelect, Tabs, TextInput, UnstyledButton } from '@mantine/core';
import { Icon } from './icons';
import { useEffect, useRef, useState } from 'react';
import type { KeychainResult, Model, Source, WeatherPreference } from '../shared/types';
import { Empty, Field, Hint, Modal, ModelPicker, stamp, useAction, useApp } from './ui';
import { readBackground, themes, type Appearance, type AppearancePatch } from './appearance';
import { WeatherSettings } from './weather';
import { GitLinks } from './git-links';
import backgroundPlaceholderArt from '../../assets/illustrations/empty-states/background.png';
function SourceEditor({ source, onClose }: {
  source?: Source;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [name, setName] = useState(source?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? '');
  const [secret, setSecret] = useState('');
  const [models, setModels] = useState<Model[]>(source?.models ?? []);
  const patch = (i: number, value: Partial<Model>) => setModels(models.map((m, n) => i === n ? { ...m, ...value } : m));
  return <Modal title={source ? '编辑模型源' : '添加模型源'} wide onClose={onClose} onSubmit={async () => {
    await call('sources.save', { ...(source ? { id: source.id, expectedVersion: source.version } : {}), name: name.trim(), baseUrl: baseUrl.trim(), models, ...(secret ? { secret } : {}) });
    setSecret('');
  }}>
    <div className="form-row">
      <Field label="源名称">
        <TextInput required data-autofocus maxLength={100} value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="协议">
        <TextInput value="OpenAI 兼容 · Chat Completions" readOnly />
      </Field>
    </div>
    <Field label="Base URL" hint="支持 HTTP / HTTPS。HTTP 会明文传输 API Key 和对话，请使用可信网络或 HTTPS。">
      <TextInput required type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://gateway.example.com/v1" autoComplete="off" />
    </Field>
    <Field label="API Key" hint={source?.credentialConfigured ? '已配置密钥；留空保留，输入新密钥更新。密钥不回读到界面。' : '不需要鉴权的模型源可以留空。'}>
      <TextInput type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" placeholder={source?.credentialConfigured ? '已配置 · 输入新密钥更新' : '输入 API Key'} />
    </Field>
    <div className="section-heading">
      <h3>
        模型列表
      </h3>
      <Button type="button" onClick={() => setModels([...models, { id: '', name: '', supportsTools: false }])}>
        <Icon name="plus" className="icon-inline" />手动添加
      </Button>
    </div>
    <p className="muted">
      工具调用能力需明确确认，不能根据模型名称推断。保存源后也可获取模型列表。
    </p>
    <div className="model-list">
      {models.map((m, i) => <div className="model-edit-row" key={i}>
        <Field label="模型名称">
          <TextInput required aria-label={`模型 ${i + 1} 名称`} value={m.name} onChange={e => patch(i, { name: e.target.value })} />
        </Field>
        <Field label="模型 ID">
          <TextInput required aria-label={`模型 ${i + 1} ID`} value={m.id} onChange={e => patch(i, { id: e.target.value })} />
        </Field>
        <Checkbox className="check" checked={m.supportsTools} onChange={e => patch(i, { supportsTools: e.target.checked })} label="支持 tools" />
        <ActionIcon type="button" aria-label={`移除模型 ${i + 1}`} onClick={() => setModels(models.filter((_, n) => n !== i))}>
          <Icon name="x" />
        </ActionIcon>
      </div>)}
    </div>
    {!models.length && <p className="muted">
      可以先保存源，再尝试获取模型，或手动添加一个模型。
    </p>}
  </Modal>;
}
function SourceDelete({ source, onClose }: { source: Pick<Source, 'id' | 'name' | 'version'>; onClose: () => void }) {
  const { call } = useApp();
  const [step, setStep] = useState(1);
  const advance = useRef(false);
  return step === 1 ? <Modal key="first" title="删除模型源？" submit="继续删除" confirmation onSubmit={async () => { advance.current = true; }} onClose={() => { if (advance.current) setStep(2); else onClose(); }}>
    <p className="break">将删除模型源「{source.name}」及其保存的 API Key。</p>
    <p className="muted">继续后还需要再次确认。</p>
  </Modal> : <Modal key="second" title="再次确认删除" submit="确认删除" confirmation onClose={onClose} onSubmit={async () => {
    await call('sources.delete', { id: source.id, expectedVersion: source.version });
  }}>
    <p className="break">确认删除「{source.name}」？此操作无法撤销。</p>
    <p>关联的默认模型将清空，使用此模型源的定时任务将暂停。历史对话和生成内容保留，继续对话时需要选择其他模型。</p>
  </Modal>;
}
function SourceConnectionTest({ source, disabled }: { source: Source; disabled: boolean }) {
  const { call } = useApp();
  const [modelId, setModelId] = useState(source.models[0]?.id ?? '');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ modelId: string; status: string; testedAt: string | null } | null>(null);
  const { busy, run } = useAction(setError);
  const status = busy ? '正在测试…' : error ? `测试失败：${error}` : result?.status || source.testStatus || '尚未测试';
  const failed = !busy && (!!error || status.startsWith('测试失败'));
  const testedAt = busy || error ? null : result?.testedAt ?? source.testedAt;
  return <>
    <div className="test-connection">
      <Field label="选择测试模型">
        <NativeSelect value={modelId} disabled={busy || disabled} onChange={e => setModelId(e.target.value)}>
          <option value="" disabled>选择模型</option>
          {source.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </NativeSelect>
      </Field>
      <Hint label="发送固定短消息，可能产生服务费用，不携带聊天或知识库内容。">
        <Button type="button" loading={busy} disabled={busy || disabled || !source.enabled || !modelId} onClick={() => void run(async () => {
          setResult({ modelId, status: '', testedAt: null });
          const tested = await call('sources.test', { id: source.id, modelId });
          setResult({ modelId, status: tested.testStatus ?? '测试完成', testedAt: tested.testedAt });
        })}>
          {busy ? '测试中…' : '测试连接'}
        </Button>
      </Hint>
    </div>
    <div className={`connection-result${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'} aria-live="polite" aria-busy={busy}>
      <Icon name={busy ? 'loader-circle' : failed ? 'triangle-alert' : testedAt ? 'check' : 'circle'} size="md" />
      <span>{!busy && !error && !result && testedAt ? '上次测试：' : ''}{status}{result && <small> · {result.modelId}</small>}{testedAt && <small> · {stamp(testedAt)}</small>}</span>
    </div>
  </>;
}
function AppearanceSettings({ appearance, backgroundUrl, disabled, onChange }: { appearance: Appearance; backgroundUrl: string | null; disabled: boolean; onChange: (patch: AppearancePatch) => Promise<void> }) {
  const { busy, run } = useAction();
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Record<string, string | number>>({ ...appearance.custom });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => setDraft({ ...appearance.custom }), [appearance.custom]);
  const locked = disabled || busy;
  async function applyCustom(reset = false) {
    const custom = reset ? { ...defaultCustomTheme } : parseCustomTheme(draft);
    if (!custom) throw new Error('自定义主题变量无效，请检查颜色或数值范围');
    await onChange({ custom });
    if (mounted.current) setDraft({ ...custom });
  }
  return <div className="appearance-settings" aria-busy={locked}>
    <h2>主题</h2>
    <div className="theme-options" role="group" aria-label="选择主题">
      {themes.map(theme => <UnstyledButton type="button" key={theme.id} className="theme-option" aria-label={theme.name} aria-pressed={appearance.theme === theme.id} disabled={locked} onClick={() => void run(() => onChange({ theme: theme.id }))}>
        <span className="theme-preview" style={previewVariables(theme.id, appearance.custom)} data-preview-theme={theme.id} aria-hidden="true"><span /><span /><span /></span>
        <span className="theme-label">{theme.name}{appearance.theme === theme.id && <Icon name="check" size="md" />}</span>
      </UnstyledButton>)}
    </div>
    {appearance.theme === 'custom' && <form className="custom-theme-editor" onSubmit={event => { event.preventDefault(); void run(() => applyCustom()); }}>
      <h3>公共变量</h3>
      <div className="custom-theme-fields">
        {customThemeFields.map(field => <div className={`custom-theme-field ${field.type}`} key={field.key}>
          <label htmlFor={`theme-${field.key}`}>{field.label}</label>
          <div className="custom-theme-value">
            {field.type === 'color' && <input type="color" aria-label={`${field.label}取色`} disabled={locked} value={/^#[0-9a-f]{6}$/i.test(String(draft[field.key])) ? String(draft[field.key]) : field.default} onChange={event => setDraft({ ...draft, [field.key]: event.currentTarget.value })} />}
            <TextInput id={`theme-${field.key}`} aria-label={field.label} type={field.type === 'number' ? 'number' : 'text'} disabled={locked} value={draft[field.key]} {...(field.type === 'number' ? { min: field.min, max: field.max, step: field.step } : { maxLength: 7, spellCheck: false })} onChange={event => setDraft({ ...draft, [field.key]: field.type === 'number' && event.currentTarget.value !== '' ? Number(event.currentTarget.value) : event.currentTarget.value })} />
          </div>
        </div>)}
      </div>
      <div className="actions"><Button type="submit" disabled={locked}>应用</Button><Button type="button" disabled={locked} onClick={() => void run(() => applyCustom(true))}>恢复默认</Button></div>
    </form>}
    <div className="background-settings">
      {backgroundUrl ? <img className="background-preview" src={backgroundUrl} alt="当前背景图片预览" /> : <img className="background-placeholder" src={backgroundPlaceholderArt} alt="" aria-hidden="true" draggable={false} />}
      <span className="background-title">背景图片</span>
      <input ref={input} type="file" hidden aria-label="上传背景图片" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (file) void run(async () => {
          const background = await readBackground(file);
          if (mounted.current) await onChange({ background });
        });
      }} />
      <Button type="button" disabled={locked} onClick={() => input.current?.click()}>{appearance.background ? '更换图片' : '上传图片'}</Button>
      {appearance.background && <Hint label="移除背景图片"><ActionIcon type="button" aria-label="移除背景图片" disabled={locked} onClick={() => void run(() => onChange({ background: null }))}><Icon name="x" /></ActionIcon></Hint>}
    </div>
  </div>;
}
function KeychainSettings() {
 const {call}=useApp();
 const [result,setResult]=useState<KeychainResult|null>(null);
 const [error,setError]=useState('');
 const initialCall=useRef(call);
 const {busy,run}=useAction(setError);
 useEffect(()=>{let active=true;void initialCall.current('security.keychain.status',{}).then(value=>{if(active)setResult(value);}).catch(()=>{if(active)setError('暂时无法检查钥匙串，请重试。');});return()=>{active=false;};},[]);
 return <div className="data-settings"><article className="entry-card" aria-label="钥匙串访问">
  <h2>钥匙串访问</h2>
  <p>允许 WorkDay 使用「WorkDay Safe Storage」保存的加密密钥，减少读取凭证时反复弹窗。</p>
  <p role="status" aria-live="polite">{busy?'正在处理，请完成 macOS 系统窗口中的确认…':result?.message??'正在检查钥匙串访问设置…'}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="actions">
   <Button type="button" className="primary" disabled={busy||!result?.canConfigure} onClick={()=>void run(async()=>setResult(await call('security.keychain.configure',{})))}>自动配置</Button>
   <Button type="button" disabled={busy} onClick={()=>void run(async()=>setResult(await call('security.keychain.status',{})))}>重新检查</Button>
   <Button type="button" disabled={busy||result?.status==='unsupported'} onClick={()=>void run(async()=>{if(!await call('security.keychain.open',{}))setError('无法打开钥匙串，请在应用程序中打开「钥匙串访问」。');})}>打开钥匙串</Button>
  </div>
  <p className="muted">只调整当前 WorkDay 的访问设置。请按系统提示确认；密码只在 macOS 窗口中输入，取消后可重试。</p>
  <p className="muted">{result?.signing==='adhoc'?'当前使用临时签名，更新后可能需要重新授权。':'更新应用或系统安全策略变化后，可能需要重新授权。'}</p>
 </article></div>;
}

export function Settings({ appearance, backgroundUrl, appearanceDisabled, onAppearanceChange, weatherPreference, onWeatherChange, initialTab = 'models' }: {
  appearance: Appearance;
  backgroundUrl: string | null;
  appearanceDisabled: boolean;
  onAppearanceChange: (patch: AppearancePatch) => Promise<void>;
  weatherPreference: WeatherPreference;
  onWeatherChange: (value: WeatherPreference) => void;
  initialTab?: 'models' | 'weather' | 'links';
}) {
  const { state, call, report } = useApp();
  const [tab, setTab] = useState<'models' | 'appearance' | 'weather' | 'data' | 'links' | 'security'>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<Source | true | null>(null);
  const [deleting, setDeleting] = useState<Pick<Source, 'id' | 'name' | 'version'> | null>(null);
  const [restore, setRestore] = useState<{
    token: string;
    summary: string;
  } | null>(null);
  const { busy, run } = useAction();
  const source = state.sources.find(s => s.id === selected) ?? state.sources[0];
  return <section className="page panel settings-page">
    <Tabs value={tab} onChange={value => { if (value) setTab(value as typeof tab); }} keepMounted={false}>
      <header className="settings-topbar">
        <h1>设置</h1>
      <Tabs.List className="tabs" aria-label="设置分类">
        <Tabs.Tab type="button" value="models">模型源</Tabs.Tab>
        <Tabs.Tab type="button" value="appearance">主题</Tabs.Tab>
        <Tabs.Tab type="button" value="weather">天气</Tabs.Tab>
        <Tabs.Tab type="button" value="data">数据与备份</Tabs.Tab>
        <Tabs.Tab type="button" value="links">关联</Tabs.Tab>
        <Tabs.Tab type="button" value="security">安全与权限</Tabs.Tab>
      </Tabs.List>
      </header>
      <Tabs.Panel value="models"><div className="settings-layout">
        <aside className="source-list" aria-label="模型源">
          <div className="section-heading">
            <h2>模型源</h2>
            <Hint label="添加模型源"><ActionIcon type="button" aria-label="添加模型源" size="var(--size-settingsControl)" onClick={() => setEdit(true)}>
              <Icon name="plus" size="md" />
            </ActionIcon></Hint>
          </div>
          {state.sources.map(s => <div className={`source-card ${source?.id === s.id ? 'selected' : ''}`} key={s.id}>
            <UnstyledButton type="button" className="source-select" aria-pressed={source?.id === s.id} onClick={() => setSelected(s.id)}>
              <strong><i className={s.enabled ? 'status-dot' : 'status-dot disabled'} /><span title={s.name}>{s.name}</span></strong>
              <span className="source-meta" title={s.testStatus ?? '未测试'}>{s.models.length} 个模型 · {s.enabled ? s.testStatus ?? '未测试' : '已停用'}</span>
            </UnstyledButton>
            <Hint label="删除模型源"><ActionIcon type="button" className="source-delete" variant="subtle" size="var(--size-settingsControl)" aria-label={`删除模型源 ${s.name}`} onClick={() => setDeleting({ id: s.id, name: s.name, version: s.version })}><Icon name="trash" size="sm" /></ActionIcon></Hint>
          </div>)}
          {!state.sources.length && <Empty art="models" compact title="添加模型源">配置地址后即可选择模型。</Empty>}
        </aside>
        <div className="source-detail">
          {source ? <>
            <div className="section-heading source-heading">
              <div className="source-heading-name"><h2 title={source.name}>{source.name}</h2><span>OpenAI 兼容</span></div>
              <div className="actions">
                <Hint label={`编辑配置 / 手动模型 · 配置版本 v${source.configVersion}`}><Button type="button" onClick={() => setEdit(source)}>编辑配置</Button></Hint>
                <Button type="button" disabled={busy} onClick={() => void run(async () => {
                  await call('sources.toggle', { id: source.id, expectedVersion: source.version, enabled: !source.enabled });
                })}>{source.enabled ? '停用' : '启用'}</Button>
              </div>
            </div>
            <dl className="facts source-facts">
              <div><dt>Base URL</dt><dd title={source.baseUrl}>{source.baseUrl}</dd></div>
              <div><dt>API Key</dt><dd>{source.credentialConfigured ? '已配置' : '未配置'}</dd></div>
            </dl>
            <div className="section-heading model-heading">
              <h3>可选模型 <span>{source.models.length}</span></h3>
              <Button type="button" disabled={busy} onClick={() => void run(async () => {
                await call('sources.models', { id: source.id });
              })}><Icon name="refresh-cw" size="sm" className="icon-inline" />获取模型</Button>
            </div>
            <ul className="model-catalog" tabIndex={0} aria-label="可选模型列表">
              {source.models.map(m => <li className="model-card" key={m.id}>
                <span className="model-name" title={m.name}>{m.name}</span>
                {m.name !== m.id && <small className="model-id" title={m.id}>{m.id}</small>}
              </li>)}
            </ul>
            {!source.models.length && <p className="muted model-empty">暂无模型，获取模型或在编辑配置中添加。</p>}
          </> : <Empty art="models" title="还没有模型源">点击左侧加号添加。</Empty>}
          <div className="source-preferences">
            {source && <div className="source-test"><SourceConnectionTest key={`${source.id}:${source.configVersion}`} source={source} disabled={busy} /></div>}
            <div className="default-model">
              <Field label="新聊天默认模型">
                <ModelPicker value={state.defaultModel} disabled={busy} onChange={model => void run(async () => {
                  await call('settings.defaultModel', { model });
                })} />
              </Field>
              <p className="muted">仅用于新聊天，已有对话保持原模型。</p>
            </div>
          </div>
        </div>
      </div></Tabs.Panel>
      <Tabs.Panel value="appearance"><AppearanceSettings appearance={appearance} backgroundUrl={backgroundUrl} disabled={appearanceDisabled} onChange={onAppearanceChange} /></Tabs.Panel>
      <Tabs.Panel value="weather"><WeatherSettings preference={weatherPreference} onChange={onWeatherChange} /></Tabs.Panel>
      <Tabs.Panel value="data"><div className="data-settings">
      <article className="entry-card">
        <h2>
          本地业务数据
        </h2>
        <p className="break muted">
          {state.dataDirectory}
        </p>
        <p>
          版本
          {state.appVersion}
          · 数据保存在本机。
        </p>
        <Button type="button" disabled={busy} onClick={() => void run(() => call('data.openDirectory', {}))}>
          打开
        </Button>
      </article>
      <article className="entry-card">
        <h2>
          创建非敏感备份
        </h2>
        <p>
          导出已提交的业务数据和组件配置。凭证与授权不会导出。
        </p>
        <Button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
          const backup = await call('data.backup', {});
          if (backup)
            report(`备份已保存：${backup.path}`);
        })}>
          创建备份
        </Button>
      </article>
      <article className="entry-card">
        <h2>
          验证并恢复到副本
        </h2>
        <p>
          先选择并验证备份，再创建独立副本。原数据保留，副本需重新配置凭证、授权与启用计划。
        </p>
        <Button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await call('data.validate', {});
          if (result)
            setRestore(result);
        })}>
          选择并验证备份
        </Button>
      </article>
    </div></Tabs.Panel>
      <Tabs.Panel value="links"><GitLinks /></Tabs.Panel>
      <Tabs.Panel value="security"><KeychainSettings /></Tabs.Panel>
    </Tabs>
    {deleting && <SourceDelete source={deleting} onClose={() => setDeleting(null)} />}
    {edit && <SourceEditor source={edit === true ? undefined : edit} onClose={() => setEdit(null)} />}

    {restore && <Modal title="备份验证通过" onClose={() => setRestore(null)} submit="恢复到新副本" onSubmit={async () => {
      const result = await call('data.restoreCopy', { token: restore.token });
      report(`恢复副本已创建：${result.path}。${result.summary}`);
    }}>
      <p className="break">
        {restore.summary}
      </p>
      <p className="notice">
        仅创建副本，原业务数据保留。模型与 MCP 凭证需重新配置。
      </p>
    </Modal>}
  </section>;
}
