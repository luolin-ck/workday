import { Button, PasswordInput, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { GitPreview, Knowledge, RepoSummary, RepositoryRef } from '../shared/types';
import { Confirm, Field, Modal, useAction, useApp } from './ui';

export function GitLinks() {
  const { state, call } = useApp();
  const [connect, setConnect] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const account = state.gitAccount;
  return <div className="git-links">
    <article className="entry-card">
      <div className="section-heading"><div><h2>GitHub</h2><p className="muted">{account ? `@${account.login} · ${account.credentialConfigured ? '已关联' : '需重新关联'}` : '未关联账号'}</p></div><div className="actions">
        <Button type="button" onClick={() => setConnect(true)}>{account ? '重新关联' : '关联账号'}</Button>
        {account && <Button type="button" onClick={() => setDisconnect(true)}>解除关联</Button>}
      </div></div>
    </article>
    {connect && <GitConnect onClose={() => setConnect(false)} />}
    {disconnect && account && <Confirm title="解除 GitHub 关联" submit="解除关联" onClose={() => setDisconnect(false)} onConfirm={async () => { await call('git.disconnect', {connectionId:account.connectionId}); setDisconnect(false); }}>
      <p>停止读取仓库，已导入的本地资料与聊天记录会保留。</p>
    </Confirm>}
  </div>;
}
function GitConnect({onClose}: {onClose: () => void}) {
  const { call } = useApp();
  const [secret, setSecret] = useState('');
  const {busy, run} = useAction();
  return <Modal title="关联 GitHub" submit="关联" onClose={onClose} onSubmit={async () => {
    const submitted = secret; setSecret('');
    await call('git.connect', {secret:submitted});
  }}>
    <Field label="Personal Access Token" hint="使用细粒度令牌，仅为需要的仓库开放 Metadata 和 Contents 只读权限。">
      <PasswordInput value={secret} onChange={event => setSecret(event.currentTarget.value)} autoComplete="new-password" required data-autofocus visibilityToggleButtonProps={{'aria-label':'显示或隐藏令牌'}} />
    </Field>
    <Button type="button" disabled={busy} onClick={() => void run(() => call('git.openSettings', {}))}>在 GitHub 创建令牌</Button>
  </Modal>;
}
export function RepositoryPicker({onSelect, onClose}: {onSelect:(repository:RepoSummary) => void; onClose:() => void}) {
  const { state, call, go } = useApp();
  const account = state.gitAccount;
  const [items, setItems] = useState<RepoSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const {busy, run} = useAction(setError);
  const current = useRef(account?.connectionId);
  current.current = account?.connectionId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function load(nextPage:number) {
    if (!account) return;
    const connectionId = account.connectionId;
    const result = await call('git.repositories', {connectionId,page:nextPage});
    if (!mounted.current || current.current !== connectionId) return;
    setItems(previous => nextPage === 1 ? result.items : [...previous, ...result.items.filter(item => !previous.some(old => old.repositoryId === item.repositoryId))]);
    setPage(nextPage + 1); setHasMore(result.hasMore);
  }
  useEffect(() => { setItems([]); setPage(1); setHasMore(true); if (account) void run(() => load(1)); }, [account?.connectionId]);
  const filtered = items.filter(item => `${item.owner}/${item.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal title="选择 GitHub 仓库" onClose={onClose} wide>
    {!account ? <><p className="muted">先关联 GitHub 账号，即可选择可访问的仓库。</p><Button type="button" onClick={() => { onClose(); go('设置', 'links'); }}>前往关联设置</Button></> : <>
      <Field label="搜索已加载仓库"><TextInput value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="仓库名称" /></Field>
      <div className="repository-list" aria-label="GitHub 仓库列表" aria-busy={busy}>
        {filtered.map(item => <UnstyledButton type="button" className="repository-card" key={item.repositoryId} onClick={() => { if (current.current === item.connectionId) onSelect(item); }}>
          <strong>{item.owner}/{item.name}</strong><small>{item.private ? '私有' : '公开'} · {item.defaultBranch}</small>{item.description && <span>{item.description}</span>}
        </UnstyledButton>)}
      </div>
      {!busy && !filtered.length && <p className="muted">{items.length ? '已加载仓库中没有匹配项。' : '暂无可访问仓库。'}</p>}
      {hasMore && <Button type="button" disabled={busy} loading={busy} onClick={() => void run(() => load(page))}>{items.length ? '加载更多' : error ? '重试' : '加载仓库'}</Button>}
      <small className="muted">仅展示此令牌可访问的仓库。</small>
      {error && <p role="alert" className="error">{error}</p>}
    </>}
  </Modal>;
}
export function RepositorySnapshot({projectId, onClose, onImported}: {projectId:string;onClose:() => void;onImported:(knowledge:Knowledge) => void}) {
  const { state, call } = useApp();
  const project = state.projects.find(item => item.id === projectId);
  const repository = project?.repository;
  const scope = JSON.stringify([projectId, project?.version, repository, state.gitAccount?.connectionId]);
  const latest = useRef(scope); latest.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [paths, setPaths] = useState('README.md');
  const [preview, setPreview] = useState<GitPreview | null>(null);
  const [error, setError] = useState('');
  const {busy, run} = useAction(setError);
  useEffect(() => setPreview(null), [scope]);
  const active = () => mounted.current && latest.current === scope;
  return <Modal title="从仓库添加上下文" wide onClose={onClose} submit="添加到本次上下文" onSubmit={preview ? async () => {
    if (!active()) throw new Error('项目已变化，请重新读取');
    const knowledge = await call('git.import', {token:preview.token});
    if (active()) onImported(knowledge);
  } : undefined}>
    <p className="muted">{repository?.owner}/{repository?.name}</p>
    <Field label="文件路径" hint="相对路径，一行一个，最多 5 个文件。只添加预览后的文本快照。">
      <Textarea rows={3} value={paths} onChange={event => { setPaths(event.currentTarget.value); setPreview(null); }} disabled={busy} />
    </Field>
    <Button type="button" disabled={busy} loading={busy} onClick={() => void run(async () => {
      const selected = [...new Set(paths.split('\n').map(path => path.trim()).filter(Boolean))];
      if (!selected.length || selected.length > 5) throw new Error('请输入 1 至 5 个文件路径');
      setPreview(null);
      const result = await call('git.preview', {projectId,paths:selected});
      if (active()) setPreview(result);
    })}>读取并预览</Button>
    {preview && <div className="repository-preview"><strong>{preview.repository}</strong><small>commit {preview.commit}</small><small>{preview.paths.join(' · ')}</small><pre tabIndex={0} aria-label="仓库实际文本预览">{preview.content}</pre></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </Modal>;
}
export function repositoryRef(item:RepositoryRef):RepositoryRef {
  return {provider:item.provider,connectionId:item.connectionId,repositoryId:item.repositoryId,owner:item.owner,name:item.name,defaultBranch:item.defaultBranch};
}
