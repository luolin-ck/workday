import { Button, Checkbox, TextInput, Textarea } from '@mantine/core';
import { Icon } from './icons';
import { useState } from 'react';
import type { Knowledge } from '../shared/types';
import { Confirm, Empty, Field, Modal, ProjectPicker, useAction, useApp } from './ui';
function KnowledgeEditor({ entry, project, onClose }: {
  entry?: Knowledge;
  project: string | null;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [name, setName] = useState(entry?.name ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [projectId, setProjectId] = useState(entry?.projectId ?? project);
  return <Modal title={entry ? '编辑知识资料' : '创建知识资料'} wide onClose={onClose} onSubmit={async () => {
    await call('knowledge.save', { ...(entry ? { id: entry.id, expectedVersion: entry.version } : {}), name: name.trim(), content, projectId });
  }}>
    <div className="form-row">
      <Field label="资料名称">
        <TextInput required maxLength={200} data-autofocus value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="关联项目">
        <ProjectPicker value={projectId} onChange={setProjectId} />
      </Field>
    </div>
    <Field label="内容（文本 / Markdown）" hint="对话时可选取片段。修改后产生新版本，历史快照继续保留。">
      <Textarea rows={18} required value={content} onChange={e => setContent(e.target.value)} />
    </Field>
  </Modal>;
}
export function KnowledgePage() {
  const { state, call } = useApp();
  const [project, setProject] = useState<string | null>(null);
  const [all, setAll] = useState(true);
  const [editing, setEditing] = useState<Knowledge | true | null>(null);
  const [remove, setRemove] = useState<Knowledge | null>(null);
  const [query, setQuery] = useState('');
  const { busy, run } = useAction();
  const entries = state.knowledge.filter(k => !k.removed && (all || k.projectId === project) && (`${k.name}\n${k.content}`).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="page panel">
    <div className="section-heading">
      <div>
        <h1>
          知识库
        </h1>
      </div>
      <div className="actions">
        <Button type="button" disabled={busy} onClick={() => void run(async () => {
          await call('knowledge.import', { projectId: project });
        })}>
          导入文本 / Markdown
        </Button>
        <Button type="button" className="primary" onClick={() => setEditing(true)}>
          <Icon name="plus" className="icon-inline" />创建资料
        </Button>
      </div>
    </div>
    <div className="toolbar">
      <TextInput aria-label="搜索知识资料" placeholder="搜索名称或内容" value={query} onChange={e => setQuery(e.target.value)} />
      <ProjectPicker value={project} includeArchived onChange={id => {
        setProject(id);
        setAll(false);
      }} />
      <Checkbox className="check" checked={all} onChange={e => setAll(e.target.checked)} label="全部项目" />
    </div>
    <div className="card-grid">
      {entries.map(k => <article className="entry-card" key={k.id}>
        <div className="section-heading">
          <h3>
            {k.name}
          </h3>
          <span className="tag">
            v
            {k.version}
          </span>
        </div>
        <span className="muted">
          {state.projects.find(p => p.id === k.projectId)?.name ?? '不在项目中'}
        </span>
        <p className="excerpt">
          {k.content.slice(0, 220)}
          {k.content.length > 220 ? '…' : ''}
        </p>
        <div className="actions">
          <Button type="button" onClick={() => setEditing(k)}>
            查看 / 编辑
          </Button>
          <Button type="button" onClick={() => setRemove(k)}>
            移除
          </Button>
        </div>
      </article>)}
    </div>
    {!entries.length && <Empty art="knowledge" title="让资料成为可用的上下文">
      创建一段文本，或导入你主动选择的 Markdown 与文本文件。
    </Empty>}
    {editing && <KnowledgeEditor entry={editing === true ? undefined : editing} project={project} onClose={() => setEditing(null)} />}

    {remove && <Confirm title="移除知识资料" submit="移除" onClose={() => setRemove(null)} onConfirm={async () => {
      await call('knowledge.remove', { id: remove.id, expectedVersion: remove.version });
    }}>
      <p>
        移除“
        {remove.name}
        ”？已发送消息中的历史快照会保留。
      </p>
    </Confirm>}
  </section>;
}
