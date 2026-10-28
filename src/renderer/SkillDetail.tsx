import { ActionIcon, Button, Menu, Modal as MantineModal, Switch } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { emptyContext, type Conversation, type Skill } from '../shared/types';
import { Icon } from './icons';
import { ComponentIcon } from './ComponentIcon';
import { Hint, useAction, useApp } from './ui';
import { componentDescription } from '../shared/component-description';

// Imported instructions are reading material here: no HTML, remote media, or navigation.
export function SkillMarkdown({ content }: { content: string }) {
  return <div className="skill-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <span className="skill-markdown-link" title={href}>{children}</span>,
    img: ({ alt }) => <span className="muted">[图片{alt ? `：${alt}` : ''}]</span>,
  }}>{content}</Markdown></div>;
}

export function SkillDetail({ skill, onClose, onEdit }: { skill: Skill; onClose: () => void; onEdit?: () => void }) {
  const { state, call, openChat } = useApp();
  const [opened, setOpened] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [source, setSource] = useState(false);
  const [error, setError] = useState('');
  const { busy, run } = useAction(setError);
  const preparedChat = useRef<Conversation | null>(null);
  const owner = state.plugins.find(p => p.id === skill.ownerPluginId);
  const ownerEnabled = !skill.ownerPluginId || !!owner?.enabled;
  const description = componentDescription(skill);
  useEffect(() => setOpened(true), []);
  function close() { if (!busy) setOpened(false); }
  async function trySkill() {
    const conversation = preparedChat.current ?? await call('conversations.create', {
      title: skill.name, projectId: null, date: null, model: state.defaultModel,
    });
    preparedChat.current = conversation;
    const current = state.conversations.find(c => c.id === conversation.id) ?? conversation;
    await call('conversations.context', {
      id: current.id, expectedVersion: current.version,
      context: { ...emptyContext(), skillRef: { id: skill.id, version: skill.version },
        ...(owner ? { pluginRefs: [{ id: owner.id, version: owner.version, skillId: skill.id, mcpRefs: [] }] } : {}),
      },
    });
    openChat(current.id, null);
  }
  return <MantineModal.Root opened={opened} onClose={close} onExitTransitionEnd={onClose} centered size="var(--size-skillDetail)"
    yOffset="var(--space-20)" xOffset="var(--space-12)" closeOnEscape={!busy && !menuOpen} closeOnClickOutside={!busy && !menuOpen}>
    <MantineModal.Overlay className="skill-detail-overlay" />
    <MantineModal.Content classNames={{ content: 'skill-detail' }}>
      <MantineModal.Body className="skill-detail-body">
        <div className="skill-detail-toolbar">
          <span className="skill-detail-icon"><ComponentIcon kind="skill" /></span>
          <div className="skill-detail-controls">
            <Hint label={ownerEnabled ? (skill.enabled ? '停用 Skill' : '启用 Skill') : '请先启用所属插件'}>
              <span><Switch aria-label="启用 Skill" checked={skill.enabled && ownerEnabled} disabled={busy || !ownerEnabled} size="sm" color="var(--mint)"
                onChange={e => { const enabled = e.currentTarget.checked; void run(() => call('skills.toggle', { id: skill.id, expectedVersion: skill.version, enabled })); }} /></span>
            </Hint>
            <Menu opened={menuOpen} onChange={setMenuOpen} position="bottom-end" withinPortal width="var(--size-pluginListMenu)">
              <Menu.Target><ActionIcon type="button" aria-label="Skill 更多操作" disabled={busy}><Icon name="ellipsis" size="md" /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{owner ? owner.name : skill.installation ? '已安装目录 Skill' : '独立 Skill'} · v{skill.version}</Menu.Label>
                <Menu.Item onClick={() => setSource(v => !v)}>{source ? '查看说明' : '查看原文'}</Menu.Item>
                {onEdit && <Menu.Item onClick={onEdit}>编辑 Skill</Menu.Item>}
              </Menu.Dropdown>
            </Menu>
            <ActionIcon type="button" aria-label="关闭详情" onClick={close} disabled={busy} data-autofocus><Icon name="x" size="md" /></ActionIcon>
          </div>
        </div>
        <div className="skill-detail-heading">
          <div className="skill-detail-title"><Hint label={skill.name}><MantineModal.Title tabIndex={0}>{skill.name}</MantineModal.Title></Hint><span>Skill</span></div>
          {description && <Hint label={description} interactive><p tabIndex={0} className="skill-detail-description">{description}</p></Hint>}
        </div>
        <div className="skill-detail-reader" role="region" aria-label={source ? 'Skill 原文' : 'Skill 说明'} tabIndex={0}>
          {source ? <pre className="skill-source">{skill.content}</pre> : <SkillMarkdown content={skill.content} />}
        </div>
        {error && <p className="error skill-detail-error" role="alert">{error}</p>}
        <div className="skill-detail-footer">
          <span className="muted">{owner ? `来自 ${owner.name}` : skill.installation ? '已安装' : '独立 Skill'}</span>
          <Hint label={ownerEnabled && skill.enabled ? '在新聊天中使用此 Skill' : '启用后即可试用'}>
            <span><Button type="button" className="primary" radius="xl" disabled={busy || !skill.enabled || !ownerEnabled} loading={busy}
              leftSection={<Icon name="messages-square" size="sm" />} onClick={() => void run(trySkill)}>立即试用</Button></span>
          </Hint>
        </div>
      </MantineModal.Body>
    </MantineModal.Content>
  </MantineModal.Root>;
}
