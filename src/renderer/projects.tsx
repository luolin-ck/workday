import { ActionIcon, Button, Collapse, Menu, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { Icon } from './icons';
import { useEffect, useState } from 'react';
import type { Conversation, Project, RepositoryRef } from '../shared/types';
import { RepositoryPicker, repositoryRef } from './git-links';
import { Hint, Confirm, Field, Modal, ProjectPicker, stamp, useAction, useApp } from './ui';
function ProjectEditor({ project, folder, repository: initialRepository, onClose }: {
  project?: Project;
  folder?: {directory: string; name: string};
  repository?: RepositoryRef;
  onClose: () => void;
}) {
  const { state, call, browseProject, go } = useApp();
  const [name, setName] = useState(project?.name ?? folder?.name ?? initialRepository?.name ?? '');
  const [repository, setRepository] = useState<RepositoryRef | null>(project?.repository ?? initialRepository ?? null);
  const [chooseRepository, setChooseRepository] = useState(false);
  const [repositoryChanged, setRepositoryChanged] = useState(!!initialRepository);
  const [directory, setDirectory] = useState(project?.directory ?? folder?.directory ?? null);
  const {busy, run} = useAction();
  const [description, setDescription] = useState(project?.description ?? '');
  return <><Modal submit={!project&&repository&&!directory?'下载并创建':'保存'} title={project ? '编辑项目' : '创建项目'} onClose={onClose} onSubmit={async () => {
    const saved = await call('projects.save', { ...(project ? { id: project.id, expectedVersion: project.version } : {}), name: name.trim(), description, directory, ...(repositoryChanged ? {repository} : {}) });
    browseProject(saved.id);
  }}>
    <Field label="项目文件夹" htmlFor="project-directory">
      <div className="project-folder-picker">
        <Hint label={directory ?? '尚未关联文件夹'}><TextInput id="project-directory" value={directory ?? ''} readOnly placeholder="尚未关联文件夹" /></Hint>
        <Button type="button" disabled={busy} onClick={() => void run(async () => {
          const selected = await call('projects.pickDirectory', {});
          if (selected) setDirectory(selected.directory);
        })}>选择文件夹</Button>
      </div>
    </Field>
    <Field label="GitHub 仓库" htmlFor="project-repository">
      <div className="project-folder-picker"><TextInput id="project-repository" value={repository ? `${repository.owner}/${repository.name}` : ''} placeholder="尚未关联仓库" readOnly />
        <Button type="button" onClick={() => setChooseRepository(true)}>选择仓库</Button>
        {repository && <Button type="button" onClick={() => { setRepository(null); setRepositoryChanged(true); }}>移除</Button>}
      </div>
    </Field>
    {repository && <p className="muted">{directory?'工作目录沿用已选文件夹；对话读取和修改本地内容。':project?'此项目尚未下载，可从项目菜单下载到桌面。':'保存时下载到桌面，完成后作为本地文件夹使用。'}</p>}
    {repository && repository.connectionId !== state.gitAccount?.connectionId && <p className="notice">账号关联已变化，请重新选择仓库。<Button type="button" onClick={() => { onClose(); go('设置', 'links'); }}>关联设置</Button></p>}
    <Field label="项目名称">
      <TextInput value={name} onChange={e => setName(e.target.value)} maxLength={100} required data-autofocus />
    </Field>
    <Field label="简介">
      <Textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} />
    </Field>
  </Modal>{chooseRepository && <RepositoryPicker onClose={() => setChooseRepository(false)} onSelect={item => { setRepository(repositoryRef(item)); setRepositoryChanged(true); setChooseRepository(false); }} />}</>;
}
function ChatEditor({ chat, kind, onClose, onMoved }: {
  chat: Conversation;
  kind: 'rename' | 'move';
  onClose: () => void;
  onMoved: (chat: Conversation) => void;
}) {
  const { call, report } = useApp();
  const [title, setTitle] = useState(chat.title);
  const [projectId, setProjectId] = useState(chat.projectId);
  return <Modal title={kind === 'rename' ? '聊天改名' : '移动聊天'} onClose={onClose} onSubmit={async () => {
    if (kind === 'rename')
      await call('conversations.rename', { id: chat.id, expectedVersion: chat.version, title: title.trim() });
    else {
      const moved = await call('conversations.move', { id: chat.id, expectedVersion: chat.version, projectId });
      onMoved(moved);
      report('聊天归属已更新，历史消息完整保留。旧项目的待发送引用已清除，请重新选择上下文。');
    }
  }}>
    {kind === 'rename' ? <Field label="聊天名称">
      <TextInput required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} data-autofocus />
    </Field> : <><Field label="移动到">
      <ProjectPicker value={projectId} onChange={setProjectId} />
    </Field><p className="notice">
        历史消息保留，后续对话可能继续使用这些内容。移动只改变聊天归属，关联任务、资料与计划保持原归属。新话题可以新建聊天。
      </p></>}
  </Modal>;
}
export function Projects({ selected, onSelect, activeChat }: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  activeChat: string | null;
}) {
  const { state, call, openChat } = useApp();
  const [edit, setEdit] = useState<{project?: Project; folder?: {directory: string; name: string}; repository?: RepositoryRef} | null>(null);
  const [chooseRepository, setChooseRepository] = useState(false);
  const [chatEdit, setChatEdit] = useState<{
    chat: Conversation;
    kind: 'rename' | 'move';
  } | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const [downloading,setDownloading]=useState(false);
  const { busy, run } = useAction();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCollapsed(previous => { const next = new Set(previous); next.delete(selected ?? 'none'); return next; });
  }, [selected, activeChat]);
  const projects = state.projects.filter(project => !project.archived);
  const chats = state.conversations.filter(chat => !chat.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  async function newChat(projectId: string | null) {
    const chat = await call('conversations.create', { projectId, date: null, model: state.defaultModel });
    openChat(chat.id, projectId);
  }
  return <section className="project-page" aria-label="项目与聊天">
    <UnstyledButton type="button" className="project-new-chat" disabled={busy} onClick={() => void run(() => newChat(selected))}>
      <Icon name="pencil" size="sidebar" />新建聊天
    </UnstyledButton>
    <div className="project-sidebar-heading">
      <h2>项目</h2>{downloading&&<span role="status" className="muted">正在下载仓库…</span>}
      <Menu position="bottom-start" withinPortal><Menu.Target><ActionIcon type="button" size="var(--size-actionSmall)" aria-label="创建项目" disabled={busy}><Icon name="plus" size="sidebar" /></ActionIcon></Menu.Target>
        <Menu.Dropdown><Menu.Item onClick={() => void run(async () => { const folder = await call('projects.pickDirectory', {}); if (folder) setEdit({folder}); })}>本地文件夹</Menu.Item><Menu.Item onClick={() => setChooseRepository(true)}>GitHub 仓库</Menu.Item></Menu.Dropdown>
      </Menu>
    </div>
    <div className="project-categories">
      {[null, ...projects].map(project => {
        const id = project?.id ?? null, key = id ?? 'none', name = project?.name ?? '不在项目中';
        const groupChats = chats.filter(chat => chat.projectId === id);
        const open = !collapsed.has(key);
        return <div className="project-group" data-project-id={key} key={key}>
          <div className="project-group-heading">
            <Hint label={project?.directory ? `${name} · ${project.directory}` : name}>
              <UnstyledButton type="button" className="project-select" aria-label={name} aria-expanded={open} aria-controls={`project-chats-${key}`} onClick={() => setCollapsed(previous => {
                const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
              })}><span className="project-toggle" aria-hidden="true"><Icon name="chevron-right" size="xs" className={open ? 'is-open' : ''} /></span><Icon name={project ? 'folder' : 'inbox'} size="sidebar" /><span className="project-label">{name}</span></UnstyledButton>
            </Hint>
            {project && <Menu position="bottom-start" width="var(--size-projectMenu)" withinPortal>
              <Menu.Target><ActionIcon type="button" size="var(--size-actionSmall)" className="project-more" aria-label={`项目操作 ${name}`}><Icon name="ellipsis" size="sidebar" /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<Icon name="plus" size="sm" />} disabled={busy} onClick={() => void run(() => newChat(id))}>新建聊天</Menu.Item>
                <Menu.Item leftSection={<Icon name="pencil" size="sm" />} onClick={() => setEdit({project})}>编辑项目</Menu.Item>
                {!project.directory&&project.repository&&<Menu.Item disabled={busy} onClick={()=>void run(async()=>{setDownloading(true);try{await call('projects.download',{id:project.id,expectedVersion:project.version});}finally{setDownloading(false);}})}>下载到桌面</Menu.Item>}
                <Menu.Item leftSection={<Icon name="inbox" size="sm" />} onClick={() => setArchiving(project)}>归档项目</Menu.Item>
              </Menu.Dropdown>
            </Menu>}
          </div>
          <Collapse expanded={open}>
            <div className="conversation-list" id={`project-chats-${key}`}>
              {groupChats.map(chat => <div className={`conversation-row ${activeChat === chat.id ? 'selected' : ''}`} key={chat.id}>
                <Hint label={`${chat.title} · ${stamp(chat.updatedAt)}`}>
                  <UnstyledButton type="button" className="conversation-open" aria-label={chat.title} aria-current={activeChat === chat.id ? 'page' : undefined} onClick={() => openChat(chat.id, chat.projectId)}>
                    <span>{chat.title}</span>
                    {chat.activeRequestId && <span className="conversation-running" role="status" aria-label="正在生成"><Icon name="loader-circle" size="xs" /></span>}
                  </UnstyledButton>
                </Hint>
                <Menu position="bottom-start" width="var(--size-chatMenu)" withinPortal>
                  <Menu.Target><ActionIcon type="button" size="var(--size-actionSmall)" className="project-more" aria-label={`聊天操作 ${chat.title}`}><Icon name="ellipsis" size="sidebar" /></ActionIcon></Menu.Target>
                  <Menu.Dropdown>
                    {chat.activeRequestId && <Menu.Label>完成或停止生成后才能移动或归档</Menu.Label>}
                    <Menu.Item leftSection={<Icon name="pencil" size="sm" />} onClick={() => setChatEdit({chat,kind:'rename'})}>改名</Menu.Item>
                    <Menu.Item leftSection={<Icon name="folder-input" size="sm" />} disabled={!!chat.activeRequestId} onClick={() => setChatEdit({chat,kind:'move'})}>移动</Menu.Item>
                    <Menu.Item leftSection={<Icon name="inbox" size="sm" />} disabled={busy || !!chat.activeRequestId} onClick={() => void run(async () => {
                      await call('conversations.archive', {id:chat.id,expectedVersion:chat.version,archived:true});
                      if (activeChat === chat.id) onSelect(chat.projectId);
                    })}>归档</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>)}
            </div>
          </Collapse>
        </div>;
      })}
    </div>
    {chooseRepository && <RepositoryPicker onClose={() => setChooseRepository(false)} onSelect={item => { setEdit({repository:repositoryRef(item)}); setChooseRepository(false); }} />}
    {edit && <ProjectEditor {...edit} onClose={() => setEdit(null)} />}
    {chatEdit && <ChatEditor {...chatEdit} onClose={() => setChatEdit(null)} onMoved={chat => {
      if (activeChat === chat.id) openChat(chat.id, chat.projectId);
    }} />}
    {archiving && <Confirm title="归档项目" onClose={() => setArchiving(null)} onConfirm={async () => {
      await call('projects.archive', {id:archiving.id,expectedVersion:archiving.version,archived:true});
      if (selected === archiving.id) onSelect(null);
    }}><p>“{archiving.name}”将从侧栏隐藏，聊天、待办与资料会保留。</p></Confirm>}
  </section>;
}
