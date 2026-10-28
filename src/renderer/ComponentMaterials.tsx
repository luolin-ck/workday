import { ActionIcon, Button } from '@mantine/core';
import { useEffect } from 'react';
import type { ComponentSession } from '../shared/types';
import { componentNames } from './ComponentDraftPreview';
import { Icon } from './icons';
import { Hint, useAction, useApp } from './ui';

export function ComponentMaterials({ session, conversationId, disabled, onBusyChange, onChange }: {
  session: ComponentSession | null; conversationId: string; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onChange: () => Promise<void>;
}) {
  const { call, go } = useApp();
  const { busy, run } = useAction();
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  if (!session?.active) return <div className="notice component-session-notice">
    <span>{session?.reason || '此管理对话已结束，请从插件页重新开始。'}</span>
    <Button type="button" onClick={() => go('插件')}>前往插件</Button>
  </div>;
  return <div className="component-materials" aria-label="组件材料">
    <div className="component-materials-toolbar">
      <span>{session.intent === 'import' ? '导入' : '创建'} {componentNames[session.kind]}</span>
      <Button type="button" variant="subtle" disabled={disabled || busy} loading={busy} leftSection={<Icon name="folder" size="sm"/>} onClick={() => void run(async () => {
        const chosen = await call('components.chooseMaterial', { conversationId });
        if (chosen) await onChange();
      })}>选择本地材料</Button>
      <Button type="button" variant="subtle" disabled={disabled || busy} onClick={() => void run(async () => {await call('components.end', {conversationId});await onChange();})}>结束管理</Button>
    </div>
    {session.materials.length > 0 && <div className="component-material-list">{session.materials.map(material => <div className="component-material" key={material.token}>
      <details><summary><span>{material.name}</span><small>{material.files.length} 个文件</small></summary><ul>{material.files.map(file => <li key={file.path}><span>{file.path}</span><small>{file.bytes.toLocaleString()} B</small></li>)}</ul></details>
      <Hint label={`移除 ${material.name}`}><ActionIcon type="button" aria-label={`移除材料 ${material.name}`} disabled={disabled || busy} onClick={() => void run(async () => {
        await call('components.removeMaterial', { conversationId, token: material.token });
        await onChange();
      })}><Icon name="x" size="sm"/></ActionIcon></Hint>
    </div>)}</div>}
  </div>;
}
