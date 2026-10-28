import { Button } from '@mantine/core';
import { useState } from 'react';
import type { ComponentDraft, ComponentKind } from '../shared/types';
import { Hint, stamp, useAction, useApp } from './ui';
import { componentDescription } from '../shared/component-description';

export const componentNames: Record<ComponentKind, string> = { skill: 'Skill', mcp: 'MCP', plugin: 'Plugin' };
const statusNames: Record<ComponentDraft['status'], string> = {
  preparing: '准备中', pending: '待确认', applying: '安装中', applied: '已安装', discarded: '已放弃', unavailable: '已失效',
};

function DraftFile({ draftId, file }: { draftId: string; file: ComponentDraft['files'][number] }) {
  const { call } = useApp();
  const [page, setPage] = useState<{ text: string; total: number; binary: boolean } | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useAction(setError);
  async function load() {
    const offset = page?.text.length ?? 0;
    const next = await call('components.readDraftFile', { draftId, path: file.path, offset, limit: 12000 });
    setPage(previous => ({ ...next, text: (previous?.text ?? '') + next.text }));
  }
  return <details className="component-draft-file" onToggle={event => { if (event.currentTarget.open && !page && !busy && !error) void run(load); }}>
    <summary><span>{file.path}</span><small>{file.bytes.toLocaleString()} B</small></summary>
    {busy && !page && <p className="muted" role="status">正在读取…</p>}
    {page?.binary ? <p className="muted">此文件为二进制资源，将随组件一同安装。</p> : <>
      {(page || file.text !== undefined) && <pre tabIndex={0}>{page?.text ?? file.text}</pre>}
      {page && page.text.length < page.total && <Button type="button" disabled={busy} loading={busy} onClick={() => void run(load)}>加载更多</Button>}
    </>}
    {error && <div className="component-draft-error"><p className="error" role="alert">{error}</p><Button type="button" disabled={busy} onClick={() => void run(load)}>重新读取</Button></div>}
  </details>;
}

export function ComponentDraftPreview({ draft, readOnly, running = false }: { draft: ComponentDraft; readOnly: boolean; running?: boolean }) {
  const { call, report } = useApp();
  const [error, setError] = useState('');
  const { busy, run } = useAction(setError);
  const canAct = !readOnly && !running && draft.status === 'pending';
  const description = draft.componentKind === 'mcp' ? draft.description : componentDescription(draft);
  return <section className="draft-card component-draft" aria-label={`${componentNames[draft.componentKind]} 安装提案`}>
    <div className="section-heading component-draft-heading">
      <div><small>{componentNames[draft.componentKind]} · 安装提案</small><Hint label={draft.name}><h4 tabIndex={0}>{draft.name}</h4></Hint></div>
      <span className="tag" role="status">{statusNames[draft.status]}</span>
    </div>
    {description && <p className="component-draft-description">{description}</p>}
    <p className="component-draft-source">来源：{draft.source}</p>
    <ul className="component-draft-changes" aria-label="安装内容">{draft.components.map((item, index) => <li key={index}>
      <span>{item.action === 'update' ? '更新' : '新增'}</span><strong>{item.name}</strong><small>{componentNames[item.kind]}{item.action === 'update' && item.expectedVersion !== undefined ? ` · 当前 v${item.expectedVersion}` : ''}</small>
    </li>)}</ul>
    {!!draft.servers?.length && <div className="component-draft-servers">{draft.servers.map((server, index) => <details key={index} open>
      <summary>{server.name} · {server.transport === 'http' ? 'HTTP' : '本地程序'}</summary>
      <dl>{server.transport === 'http' ? <><dt>地址</dt><dd>{server.url}</dd></> : <><dt>程序</dt><dd>{server.command}</dd><dt>参数</dt><dd><pre>{JSON.stringify(server.args, null, 2)}</pre></dd></>}</dl>
      {server.configurationReason && <p className="notice">{server.configurationReason}</p>}
    </details>)}</div>}
    {draft.files.length > 0 && <details className="component-draft-files">
      <summary>文件与内容 · {draft.files.length} 项</summary>
      <div className="component-draft-file-list">{draft.files.map(file => <DraftFile key={draft.id + ':' + file.path} draftId={draft.id} file={file}/>)}</div>
    </details>}
    {draft.componentKind === 'mcp' && <p className="muted component-draft-note">添加后保持停用；连接、凭证和授权可在 MCP 中配置。</p>}
    {draft.componentKind !== 'mcp' && <p className="muted component-draft-note">安装后不会自动运行脚本或连接服务。</p>}
    {(draft.error || error) && <p className="error" role="alert">{error || draft.error}</p>}
    {draft.status === 'unavailable' && !draft.error && <p className="notice">此提案已失效，请从插件页重新开始。</p>}
    {draft.status === 'preparing' && <p className="muted" role="status">等待回复完成后即可确认安装。</p>}
    {draft.status === 'applied' && draft.receipt && <p className="muted component-draft-note">已安装 · {stamp(draft.receipt.installedAt)}</p>}
    {draft.status === 'pending' && <div className="actions component-draft-actions">
      <Button type="button" className="primary" disabled={busy || !canAct} loading={busy} onClick={() => void run(async () => {
        await call('components.confirm', { draftId: draft.id, expectedVersion: draft.version });
        report(`${componentNames[draft.componentKind]} 已安装。`);
      })}>确认安装</Button>
      <Button type="button" disabled={busy || !canAct} onClick={() => void run(async () => { await call('components.discard', { draftId: draft.id, expectedVersion: draft.version }); })}>放弃</Button>
    </div>}
  </section>;
}
