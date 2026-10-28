import { ActionIcon, Button, Checkbox, Menu, NativeSelect, Tabs, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { Icon } from './icons';
import { ComponentIcon } from './ComponentIcon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Grant, McpServer, Plugin, ComponentMigrationPreview, ComponentKind, ComponentIntent, Skill } from '../shared/types';
import { Confirm, Empty, Field, Hint, Modal, stamp, useAction, useApp } from './ui';
import { SkillDetail } from './SkillDetail';
import { PluginDetail } from './PluginDetail';
import { planPluginTrial, preparePluginPicker, takePluginManagement } from './plugin-trial';
import type { Conversation } from '../shared/types';
import { prepareChatInput } from './chat';
import { componentDescription } from '../shared/component-description';

function useComponentChat() {
  const { call, openChat } = useApp();
  const { busy, run } = useAction();
  return { busy, start: (kind: ComponentKind, intent: ComponentIntent) => void run(async () => {
    const { conversation, initialPrompt } = await call('components.start', { kind, intent });
    prepareChatInput(conversation.id, initialPrompt);
    openChat(conversation.id, null);
  }) };
}
function ComponentActions({ kind, busy, onCreate, onImport, children }: {
  kind: 'Skill' | 'MCP' | 'Plugin'; busy: boolean;
  onCreate: () => void; onImport: () => void; children?: ReactNode;
}) {
  return <div className="component-add-actions" role="group" aria-label={`${kind} 新增操作`}>
    <Button type="button" className="primary component-add-main" aria-label={`新增 ${kind}`} disabled={busy} onClick={onCreate}>
      <Icon name="plus" />新增
    </Button>
    <Menu position="bottom-end" withinPortal width="max-content">
      <Menu.Target><ActionIcon type="button" className="primary component-add-toggle" aria-label={`${kind} 更多操作`} disabled={busy}>
        <Icon name="chevron-right" className="component-add-chevron" size="sm" />
      </ActionIcon></Menu.Target>
      <Menu.Dropdown className="component-add-menu">
        <Menu.Item disabled={busy} onClick={onImport}>导入 {kind}</Menu.Item>
        {children && <><Menu.Divider />{children}</>}
      </Menu.Dropdown>
    </Menu>
  </div>;
}
function objectJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('请输入 JSON 对象。');
  return value as Record<string, unknown>;
}
function PluginListItem({ name, description, meta, kind, enabled, onOpen, children }: {
  name: string; description: string; meta: string; kind: ComponentKind; enabled: boolean; onOpen: () => void; children: ReactNode;
}) {
  return <article className="plugin-list-item" role="listitem">
    <Hint label={[name, description, meta].filter(Boolean).join('\n')} className="plugin-item-tooltip" interactive>
      <UnstyledButton type="button" className="plugin-item-main" aria-label={`查看 ${name}`} onClick={onOpen}>
        <span className="plugin-item-icon"><ComponentIcon kind={kind} /></span>
        <span className="plugin-item-copy"><span className="plugin-item-title">{name}</span><span className="plugin-item-description">{description || '暂无说明'}</span></span>
      </UnstyledButton>
    </Hint>
    <div className="plugin-item-end">
      <span className="plugin-item-status" role="img" aria-label={enabled ? '已启用' : '已停用'}><Icon name={enabled ? 'check' : 'circle'} size="sm" /></span>
      <Menu position="bottom-end" withinPortal width="var(--size-pluginListMenu)">
        <Menu.Target><ActionIcon type="button" className="plugin-item-more" size="var(--size-pluginListAction)" aria-label={`更多操作 ${name}`}><Icon name="ellipsis" size="md" /></ActionIcon></Menu.Target>
        <Menu.Dropdown className="plugin-item-menu"><Menu.Label>{meta}</Menu.Label>{children}</Menu.Dropdown>
      </Menu>
    </div>
  </article>;
}
function SkillEditor({ skill, onClose }: {
  skill?: Skill;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [descriptionZh, setDescriptionZh] = useState(skill?.descriptionZh ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const owned = !!skill?.ownerPluginId||!!skill?.installation;
  return <Modal title={owned ? skill?.ownerPluginId?'查看 Plugin Skill':'查看目录 Skill' : skill ? '编辑 Skill' : '创建 Skill'} wide onClose={onClose} {...(owned ? {} : {
    onSubmit: async () => {
      await call('skills.save', { ...(skill ? { id: skill.id, expectedVersion: skill.version } : {}), name: name.trim(), description, descriptionZh, content });
    }
  })}>
    <Field label="名称">
      <TextInput required maxLength={100} value={name} onChange={e => setName(e.target.value)} readOnly={owned} data-autofocus />
    </Field>
    <Field label="原描述">
      <Textarea rows={2} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} readOnly={owned} />
    </Field>
    <Field label="中文描述" hint="优先展示中文描述；留空时使用原描述。">
      <Textarea rows={2} maxLength={20000} value={descriptionZh} onChange={e => setDescriptionZh(e.target.value)} readOnly={owned} />
    </Field>
    <Field label="指令与输出格式" hint="加载指令与主动选择的资料；附带脚本不会自动执行。">
      <Textarea required rows={15} value={content} onChange={e => setContent(e.target.value)} readOnly={owned} />
    </Field>
    {owned && <p className="notice">
      {skill?.ownerPluginId?'此组件由 Plugin 管理。':'目录与资源已安装；可重新导入并预览升级。'}
    </p>}
  </Modal>;
}
function McpEditor({ server, onClose }: {
  server?: McpServer;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpServer['transport']>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState(JSON.stringify(server?.args ?? [], null, 2));
  const [url, setUrl] = useState(server?.url ?? '');
  const [secret, setSecret] = useState('');
  const owned = false;
  return <Modal title={owned ? '查看 Plugin MCP 配置' : server ? '编辑 MCP 连接' : '添加 MCP 连接'} wide onClose={onClose} {...(owned ? {} : {
    onSubmit: async () => {
      const parsed: unknown = JSON.parse(args);
      if (!Array.isArray(parsed) || parsed.some(a => typeof a !== 'string'))
        throw new Error('参数必须是 JSON 字符串数组。');
      await call('mcp.save', { ...(server ? { id: server.id, expectedVersion: server.version } : {}), name: name.trim(), transport, command: transport === 'stdio' ? command : '', args: transport === 'stdio' ? parsed : [], url: transport === 'http' ? url : '', ...(secret ? { secret } : {}) });
      setSecret('');
    }
  })}>
    <Field label="连接名称">
      <TextInput required maxLength={100} value={name} onChange={e => setName(e.target.value)} readOnly={owned} data-autofocus />
    </Field>
    <Field label="传输方式">
      <NativeSelect value={transport} onChange={e => setTransport(e.target.value as McpServer['transport'])} disabled={owned}>
        <option value="stdio">
          本地 stdio
        </option>
        <option value="http">
          Streamable HTTP
        </option>
      </NativeSelect>
    </Field>
    {transport === 'stdio' ? <><Field label="程序绝对路径" hint="明确的可执行程序；不会通过 shell 解析。保存后需预览并启用。">
      <TextInput required value={command} onChange={e => setCommand(e.target.value)} placeholder="/absolute/path/to/program" readOnly={owned} />
    </Field><Field label="参数（JSON 字符串数组）">
        <Textarea className="code" rows={5} value={args} onChange={e => setArgs(e.target.value)} spellCheck={false} readOnly={owned} />
      </Field></> : <><Field label="HTTP 服务地址">
        <TextInput type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://server.example.com/mcp" readOnly={owned} />
      </Field>{!owned && <Field label="认证密钥" hint={server?.credentialConfigured ? '已配置；留空保留，输入新密钥更新。' : '按服务要求填入，不回读。'}>
        <TextInput type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} />
      </Field>}</>}
    <p className="notice">
      启用只允许连接。发现能力后，仍需按具体聊天或定时计划分别授予只读权限。
    </p>
  </Modal>;
}
type Scope = {
  scopeType: 'conversation' | 'schedule';
  scopeId: string;
};
type Capability = {
  type: 'tool' | 'resource';
  name: string;
  schema: Record<string, unknown>;
};
function GrantEditor({ server, scope, capability, grant, onClose }: {
  server: McpServer;
  scope: Scope;
  capability: Capability;
  grant?: Grant;
  onClose: () => void;
}) {
  const { call } = useApp();
  const [schema, setSchema] = useState(JSON.stringify(grant?.allowedSchema ?? capability.schema, null, 2));
  const [confirmed, setConfirmed] = useState(false);
  const revoked = useRef(false);
  return <Modal title={grant ? '编辑只读授权范围' : '授予具体只读能力'} wide onClose={onClose} submit={grant ? '替换授权范围' : '授予只读权限'} onSubmit={async () => {
    const allowedSchema = objectJson(schema);
    if (!confirmed)
      throw new Error('请确认服务可信、能力只读与具体允许范围。');
    if (grant && !revoked.current) {
      await call('grants.revoke', { id: grant.id, expectedVersion: grant.version });
      revoked.current = true;
    }
    await call('grants.save', { ...scope, mcpId: server.id, configVersion: server.configVersion, capabilityType: capability.type, capabilityName: capability.name, readOnly: true, allowedSchema });
  }}>
    <dl className="facts">
      <div>
        <dt>
          服务
        </dt>
        <dd>
          {server.name}
          · 配置 v
          {server.configVersion}
        </dd>
      </div>
      <div>
        <dt>
          具体能力
        </dt>
        <dd>
          {capability.type === 'tool' ? '工具' : '资源'}
          ·
          {capability.name}
        </dd>
      </div>
      <div>
        <dt>
          授权范围
        </dt>
        <dd>
          此
          {scope.scopeType === 'conversation' ? '聊天' : '定时计划'}
          ：
          {scope.scopeId}
        </dd>
      </div>
    </dl>
    <Field label="允许参数范围 · JSON Schema" hint="使用 const / enum 等约束路径或参数。工具参数必须同时满足实际 inputSchema 与此范围；资源按 {uri} 校验。">
      <Textarea className="code" rows={13} value={schema} onChange={e => setSchema(e.target.value)} spellCheck={false} />
    </Field>
    <Checkbox className="check" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} label="我信任此服务，确认此能力只读，并授权上述具体范围" />
    {grant && <p className="notice">
      替换时先撤销旧授权，再保存新范围。若保存失败，旧授权保持撤销，避免继续使用过宽范围。
    </p>}
  </Modal>;
}
function ManualCall({ server, scope, capability, onClose }: {
  server: McpServer;
  scope: Scope;
  capability: Capability;
  onClose: () => void;
}) {
  const { state, call } = useApp();
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, run } = useAction(setError);
  const projectId = scope.scopeType === 'conversation' ? state.conversations.find(c => c.id === scope.scopeId)?.projectId ?? null : state.schedules.find(s => s.id === scope.scopeId)?.projectId ?? null;
  return <Modal title={`${capability.type === 'tool' ? '调用工具' : '读取资源'} · ${capability.name}`} wide onClose={onClose}>
    <p className="muted">
      服务
      {server.name}
      · 仅使用当前
      {scope.scopeType === 'conversation' ? '聊天' : '计划'}
      的有效授权，主进程再次校验配置版本与参数范围。
    </p>
    {capability.type === 'tool' && <><Field label="工具参数 · JSON 对象">
      <Textarea rows={8} className="code" value={args} onChange={e => setArgs(e.target.value)} spellCheck={false} />
    </Field><details>
        <summary>
          实际 inputSchema
        </summary>
        <pre>
          {JSON.stringify(capability.schema, null, 2)}
        </pre>
      </details></>}
    <Button type="button" className="primary" disabled={busy} onClick={() => void run(async () => {
      const value = capability.type === 'tool' ? await call('mcp.call', { id: server.id, ...scope, name: capability.name, arguments: objectJson(args) }) : await call('mcp.readResource', { id: server.id, ...scope, uri: capability.name });
      setResult(value);
      setSaved(false);
    })}>
      {busy ? '处理中…' : capability.type === 'tool' ? '调用已授权只读工具' : '读取已授权资源'}
    </Button>
    {error && <p className="error" role="alert">{error}</p>}
    {result !== null && <div className="manual-result">
      <h3>
        返回数据
      </h3>
      <pre>
        {result}
      </pre>
      <Button type="button" disabled={busy} onClick={() => void run(async () => {
        await call('knowledge.save', { name: `${server.name} · ${capability.name}`.slice(0, 200), content: result, projectId });
        setSaved(true);
      })}>
        保存为知识资料
      </Button>
      {saved && <p className="notice" role="status">已保存为知识资料，可在对话上下文中主动选择。</p>}
      <p className="muted">
        返回值作为数据保存；不会自动加入模型请求。
      </p>
    </div>}
  </Modal>;
}
function McpManager({ownerPluginId=null,initialServerId=null,initialConversationId=null}:{ownerPluginId?:string|null;initialServerId?:string|null;initialConversationId?:string|null}) {
  const { state, call, report } = useApp();
  const authoring = useComponentChat();
  const [selected, setSelected] = useState<string | null>(initialServerId);
  const [edit, setEdit] = useState<McpServer | null>(null);
  const [enabling, setEnabling] = useState<McpServer | null>(null);
  const [scopeType, setScopeType] = useState<Scope['scopeType']>('conversation');
  const [scopeId, setScopeId] = useState(initialConversationId ?? '');
  const [grantEdit, setGrantEdit] = useState<{
    capability: Capability;
    grant?: Grant;
  } | null>(null);
  const [manual, setManual] = useState<Capability | null>(null);
  const { busy, run } = useAction();
  const servers=state.mcpServers.filter(m=>m.ownerPluginId===ownerPluginId);
  const server = servers.find(m => m.id === selected);
  const options = scopeType === 'conversation' ? state.conversations : state.schedules;
  const actualScope = options.some(o => o.id === scopeId) ? scopeId : options[0]?.id ?? '';
  const scope = { scopeType, scopeId: actualScope };
  const grants = state.grants.filter(g => !g.revoked && g.mcpId === server?.id && g.scopeType === scopeType && g.scopeId === actualScope);
  const capabilities: Capability[] = server ? [...server.tools.map(t => ({ type: 'tool' as const, name: t.name, schema: t.inputSchema })), ...server.resources.map(r => ({ type: 'resource' as const, name: r.uri, schema: { type: 'object', properties: { uri: { const: r.uri } }, required: ['uri'], additionalProperties: false } }))] : [];
  return <div className={`mcp-manager${ownerPluginId ? ' mcp-manager-embedded' : ''}`}>
    {(!ownerPluginId || !!servers.length) && <div className="section-heading">
      <p className="muted">
        连接、能力发现和具体授权分别进行。
      </p>
      <div className="actions">{server && <Button type="button" onClick={() => setSelected(null)}>返回 MCP 列表</Button>}{!ownerPluginId && <ComponentActions kind="MCP" busy={authoring.busy} onCreate={() => authoring.start('mcp', 'create')} onImport={() => authoring.start('mcp', 'import')} />}</div>
    </div>}
    {!servers.length && (ownerPluginId ? <p className="plugin-management-empty">此插件未包含 MCP 服务</p> : <Empty art="mcp" title="连接一个可信的 MCP 服务">
      配置明确的本地程序或 HTTP 地址。
    </Empty>)}
    {!!servers.length && !server && <div className="plugin-list" role="list" aria-label="MCP 列表">
      {servers.map(m => <PluginListItem key={m.id} name={m.name} description={m.configurationReason ? `需配置：${m.configurationReason}` : m.transport === 'http' ? m.url : [m.command, ...m.args].join(' ')} meta={`${m.transport} · 配置 v${m.configVersion}${m.ownerPluginId ? ' · Plugin：' + (state.plugins.find(p => p.id === m.ownerPluginId)?.name ?? '所属包') : ' · 独立配置'}`} kind="mcp" enabled={m.enabled && (!m.ownerPluginId || !!state.plugins.find(p => p.id === m.ownerPluginId)?.enabled)} onOpen={() => setSelected(m.id)}>
        <Menu.Item onClick={() => setSelected(m.id)}>管理连接与授权</Menu.Item>
        <Menu.Item onClick={() => setEdit(m)}>{m.ownerPluginId ? '查看配置' : '编辑配置'}</Menu.Item>
        <Menu.Item disabled={busy} onClick={() => { if (m.enabled) void run(() => call('mcp.toggle', { id: m.id, expectedVersion: m.version, enabled: false })); else setEnabling(m); }}>{m.enabled ? '停用' : '预览并启用'}</Menu.Item>
      </PluginListItem>)}
    </div>}
    {server && <div className="source-detail">
        <div className="section-heading">
          <h2 className="component-detail-heading"><ComponentIcon kind="mcp" /><span>{server.name}</span></h2>
          <div className="actions">
            <Button type="button" onClick={() => setEdit(server)}>
              {server.ownerPluginId ? '查看配置' : '编辑配置'}
            </Button>
            <Button type="button" disabled={busy} onClick={() => {
              if (server.enabled)
                void run(async () => {
                  await call('mcp.toggle', { id: server.id, expectedVersion: server.version, enabled: false });
                });
              else
                setEnabling(server);
            }}>
              {server.enabled ? '停用' : '预览并启用'}
            </Button>
            <Button type="button" disabled={busy || !server.enabled} onClick={() => void run(async () => {
              await call('mcp.discover', { id: server.id });
              report('MCP 能力发现完成。');
            })}>
              连接 / 发现能力
            </Button>
          </div>
        </div>
        {server.configurationReason&&<p className="notice">需配置：{server.configurationReason}</p>}
        <p className="break muted">
          {server.transport === 'stdio' ? `${server.command} ${server.args.map(a => JSON.stringify(a)).join(' ')}` : server.url}
        </p>
        <p className="muted">
          {server.credentialConfigured ? '凭证已配置 · ' : ''}
          上次发现：
          {stamp(server.discoveredAt)}
        </p>
        <div className="scope-selector">
          <Field label="授权所属范围">
            <NativeSelect value={scopeType} onChange={e => {
              setScopeType(e.target.value as Scope['scopeType']);
              setScopeId('');
            }}>
              <option value="conversation">
                聊天
              </option>
              <option value="schedule">
                定时计划
              </option>
            </NativeSelect>
          </Field>
          <Field label={scopeType === 'conversation' ? '选择聊天' : '选择计划'}>
            <NativeSelect value={actualScope} onChange={e => setScopeId(e.target.value)}>
              <option value="" disabled>
                请先创建
                {scopeType === 'conversation' ? '聊天' : '计划'}
              </option>
              {options.map(o => <option key={o.id} value={o.id}>
                {'title' in o ? o.title : o.name}
              </option>)}
            </NativeSelect>
          </Field>
          {!options.length && scopeType === 'conversation' && <Button type="button" disabled={busy} onClick={() => void run(async () => {
            const c = await call('conversations.create', { projectId: null, date: null, model: state.defaultModel });
            setScopeId(c.id);
          })}>
            创建无项目聊天
          </Button>}
        </div>
        <h3>
          发现的工具 ·
          {server.tools.length}
        </h3>
        {server.tools.map(t => <article className="capability" key={`tool:${t.name}`}>
          <div className="section-heading">
            <strong>
              {t.name}
            </strong>
            <div className="actions">
              <Button type="button" disabled={!actualScope || !server.enabled} onClick={() => setGrantEdit({ capability: capabilities.find(c => c.type === 'tool' && c.name === t.name)! })}>
                授权只读范围
              </Button>
              <Button type="button" disabled={!server.enabled || !grants.some(g => g.capabilityType === 'tool' && g.capabilityName === t.name && g.configVersion === server.configVersion)} onClick={() => setManual(capabilities.find(c => c.type === 'tool' && c.name === t.name)!)}>
                手动调用
              </Button>
            </div>
          </div>
          <p className="muted">
            {t.description}
          </p>
          <details>
            <summary>
              参数结构
            </summary>
            <pre>
              {JSON.stringify(t.inputSchema, null, 2)}
            </pre>
          </details>
        </article>)}
        <h3>
          发现的资源 ·
          {server.resources.length}
        </h3>
        {server.resources.map(r => <article className="capability" key={`resource:${r.uri}`}>
          <strong>
            {r.name}
          </strong>
          <p className="break muted">
            {r.uri}
          </p>
          <div className="actions">
            <Button type="button" disabled={!actualScope || !server.enabled} onClick={() => setGrantEdit({ capability: capabilities.find(c => c.type === 'resource' && c.name === r.uri)! })}>
              授权此资源
            </Button>
            <Button type="button" disabled={!server.enabled || !grants.some(g => g.capabilityType === 'resource' && g.capabilityName === r.uri && g.configVersion === server.configVersion)} onClick={() => setManual(capabilities.find(c => c.type === 'resource' && c.name === r.uri)!)}>
              读取资源
            </Button>
          </div>
        </article>)}
        <h3>
          发现的提示模板 ·
          {server.prompts.length}
        </h3>
        {server.prompts.map(p => <p key={p.name}>
          <strong>
            {p.name}
          </strong>
          <small>
            ·
            {p.description}
          </small>
        </p>)}
        {!server.discoveredAt && <p className="notice">
          启用连接后点击“连接 / 发现能力”，读取真实的 tools、resources 与 prompts。
        </p>}
        <h3>
          此范围的只读授权 ·
          {grants.length}
        </h3>
        {grants.map(g => <article className="grant-row" key={g.id}>
          <div>
            <strong>
              {g.capabilityType === 'tool' ? '工具' : '资源'}
              ·
              {g.capabilityName}
            </strong>
            <small>
              配置 v
              {g.configVersion}
              {g.configVersion !== server.configVersion ? ' · 已失效，请重新授权' : ''}
            </small>
            <details>
              <summary>
                允许范围
              </summary>
              <pre>
                {JSON.stringify(g.allowedSchema, null, 2)}
              </pre>
            </details>
          </div>
          <div className="actions">
            <Button type="button" disabled={busy || g.configVersion !== server.configVersion} onClick={() => {
              const capability = capabilities.find(c => c.type === g.capabilityType && c.name === g.capabilityName);
              if (capability)
                setGrantEdit({ capability, grant: g });
            }}>
              编辑范围
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(async () => {
              await call('grants.revoke', { id: g.id, expectedVersion: g.version });
            })}>
              撤销
            </Button>
          </div>
        </article>)}
        {!grants.length && <p className="muted">
          此范围尚无授权。服务启用不会自动授予任何能力。
        </p>}
      </div>}
    {edit && <McpEditor server={edit} onClose={() => setEdit(null)} />}

    {enabling && <Confirm title="预览并启用 MCP 连接" submit="确认启用" onClose={() => setEnabling(null)} onConfirm={async () => {
      await call('mcp.toggle', { id: enabling.id, expectedVersion: enabling.version, enabled: true });
    }}>
      <h3>
        {enabling.name}
      </h3>
      <p>
        {enabling.transport === 'stdio' ? '将按下列配置启动本地子进程：' : '将按下列地址连接远程服务：'}
      </p>
      <pre>
        {enabling.transport === 'stdio' ? JSON.stringify({ command: enabling.command, args: enabling.args }, null, 2) : enabling.url}
      </pre>
      <p className="notice">
        确认你信任此程序或服务。启用后仍需对发现的具体只读能力授权。
      </p>
    </Confirm>}

    {server && grantEdit && <GrantEditor server={server} scope={scope} {...grantEdit} onClose={() => setGrantEdit(null)} />}

    {server && manual && <ManualCall server={server} scope={scope} capability={manual} onClose={() => setManual(null)} />}
  </div>;
}
export function PluginsPage() {
  const {state,call,report,openChat}=useApp();
  const [error,setError]=useState('');
  const {busy,run}=useAction(setError);
  const authoring=useComponentChat();
  const [tab,setTab]=useState<'Skill'|'MCP'|'Plugin'>('Skill');
  const [skillDetailId,setSkillDetailId]=useState<string|null>(null);
  const [skillEdit,setSkillEdit]=useState<Skill|null>(null),[uninstall,setUninstall]=useState<Plugin|null>(null),[componentPluginId,setComponentPluginId]=useState<string|null>(null),[migration,setMigration]=useState<ComponentMigrationPreview|null>(null);
  const [management,setManagement]=useState<{serverId:string|null;conversationId:string|null}|null>(null);
  const componentPlugin=state.plugins.find(p=>p.id===componentPluginId);
  const managedSkills=componentPlugin ? state.skills.filter(s=>s.ownerPluginId===componentPlugin.id) : [];
  const managedMcpCount=componentPlugin ? state.mcpServers.filter(m=>m.ownerPluginId===componentPlugin.id).length : 0;
  const preparedTrial=useRef<{pluginId:string;conversation:Conversation}|null>(null);
  useEffect(()=>{const intent=takePluginManagement();if(intent){setTab('Plugin');setComponentPluginId(intent.pluginId);setManagement({serverId:null,conversationId:intent.conversationId});}},[]);
  function openPlugin(plugin:Plugin){setError('');setComponentPluginId(plugin.id);setManagement(null);preparedTrial.current=null;}
  function closeManagement(){
    const conversationId=management?.conversationId;
    const conversation=state.conversations.find(c=>c.id===conversationId&&!c.archived);
    setManagement(null);
    if(conversation&&componentPlugin){
      preparePluginPicker(conversation.id,componentPlugin.id);
      openChat(conversation.id,conversation.projectId);
    }
  }
  async function tryPlugin(skill?:Skill,prompt?:string){
    if(!componentPlugin)return;
    const plan=planPluginTrial(componentPlugin,state.skills,skill?.id);
    let created=preparedTrial.current?.pluginId===componentPlugin.id?preparedTrial.current.conversation:null;
    if(!created){created=await call('conversations.create',{title:componentPlugin.name,projectId:null,date:null,model:state.defaultModel});preparedTrial.current={pluginId:componentPlugin.id,conversation:created};}
    const current=state.conversations.find(c=>c.id===created.id)??created;
    const updated=await call('conversations.context',{id:current.id,expectedVersion:current.version,context:plan.context});
    preparedTrial.current={pluginId:componentPlugin.id,conversation:updated};
    if(prompt)prepareChatInput(updated.id,prompt);
    if(plan.needsPicker)preparePluginPicker(updated.id,componentPlugin.id);
    openChat(updated.id,null);
  }
  const independent=state.skills.filter(s=>s.ownerPluginId===null);
  const skillDetail=state.skills.find(s=>s.id===skillDetailId);
  function skillItem(s:Skill){return <PluginListItem key={s.id} name={s.name} description={componentDescription(s)} meta={`v${s.version} · ${s.installation?'已安装指令与资源，依赖未验证':'独立指令'}`} kind="skill" enabled={s.enabled} onOpen={()=>setSkillDetailId(s.id)}>
    <Menu.Item onClick={()=>s.installation?setSkillDetailId(s.id):setSkillEdit(s)}>{s.installation?'查看':'查看 / 编辑'}</Menu.Item><Menu.Item disabled={busy} onClick={()=>void run(()=>call('skills.toggle',{id:s.id,expectedVersion:s.version,enabled:!s.enabled}))}>{s.enabled?'停用':'启用'}</Menu.Item>
  </PluginListItem>;}
  return <section className="page panel">
    {componentPlugin ? <PluginDetail plugin={componentPlugin}
      skills={state.skills.filter(s=>s.ownerPluginId===componentPlugin.id&&componentPlugin.skillIds.includes(s.id))}
      servers={state.mcpServers.filter(m=>m.ownerPluginId===componentPlugin.id&&componentPlugin.mcpIds.includes(m.id))}
      busy={busy} error={error} onBack={()=>{setComponentPluginId(null);setManagement(null);setError('');}}
      onManage={()=>setManagement({serverId:null,conversationId:null})} onUninstall={()=>setUninstall(componentPlugin)}
      onToggle={()=>void run(()=>call('plugins.toggle',{id:componentPlugin.id,expectedVersion:componentPlugin.version,enabled:!componentPlugin.enabled}))}
      onOpenSkill={s=>setSkillDetailId(s.id)} onOpenMcp={m=>setManagement({serverId:m.id,conversationId:null})}
      onTry={(skill,prompt)=>void run(()=>tryPlugin(skill,prompt))}/> : <>
    <div className="section-heading"><h1>插件</h1></div>
    {error&&<p className="error" role="alert">{error}</p>}
    <Tabs value={tab} onChange={v=>{if(v)setTab(v as typeof tab);}} keepMounted={false}>
      <Tabs.List className="tabs" aria-label="插件类型">{(['Skill','MCP','Plugin'] as const).map(t=><Tabs.Tab type="button" key={t} value={t}>{t}</Tabs.Tab>)}</Tabs.List>
      <Tabs.Panel value="Skill"><div className="section-heading"><p className="muted">独立 Skill；插件组件在所属 Plugin 中管理。</p><ComponentActions kind="Skill" busy={authoring.busy} onCreate={()=>authoring.start('skill','create')} onImport={()=>authoring.start('skill','import')}/></div><div className="plugin-list" role="list" aria-label="Skill 列表">{independent.map(skillItem)}</div>{!independent.length&&<Empty art="skills" title="为 AI 准备一套工作方法">创建指令或导入包含资源的 Skill 目录，在聊天中主动选用。</Empty>}</Tabs.Panel>
      <Tabs.Panel value="MCP"><McpManager/></Tabs.Panel>
      <Tabs.Panel value="Plugin"><div className="section-heading"><p className="muted">统一管理包内 Skill、MCP 与资源，连接和执行分别授权。</p><ComponentActions kind="Plugin" busy={authoring.busy} onCreate={()=>authoring.start('plugin','create')} onImport={()=>authoring.start('plugin','import')}>
        {state.plugins.some(p=>/^codex-skills-0[1-6]$/.test(p.pluginKey)) ? <Menu.Item disabled={busy} onClick={()=>void run(async()=>{const p=await call('components.previewLegacy',{});if(p)setMigration(p);})}>整理旧导入</Menu.Item> : null}
      </ComponentActions></div>
        <div className="plugin-list" role="list" aria-label="Plugin 列表">{state.plugins.map(p=><PluginListItem key={p.id} name={p.name} description={componentDescription(p)} meta={`${p.pluginKey} · ${p.versionDeclared===false?'版本未声明':'v'+p.packageVersion}`} kind="plugin" enabled={p.enabled} onOpen={()=>openPlugin(p)}><Menu.Item onClick={()=>openPlugin(p)}>组件 · {p.skillIds.length+p.mcpIds.length}</Menu.Item><Menu.Item disabled={busy} onClick={()=>void run(()=>call('plugins.toggle',{id:p.id,expectedVersion:p.version,enabled:!p.enabled}))}>{p.enabled?'停用':'启用'}</Menu.Item><Menu.Item color="red" onClick={()=>setUninstall(p)}>卸载</Menu.Item></PluginListItem>)}</div>{!state.plugins.length&&<Empty art="plugins" title="以组合包管理能力">安装完整包，按需选择其组件。安装不会自动连接服务、运行 hook 或授予执行权限。</Empty>}
      </Tabs.Panel>
    </Tabs></>}
    {skillEdit&&<SkillEditor skill={skillEdit} onClose={()=>setSkillEdit(null)}/>}
    {skillDetail&&!skillEdit&&<SkillDetail key={skillDetail.id} skill={skillDetail} onClose={()=>setSkillDetailId(null)} {...(!skillDetail.installation&&!skillDetail.ownerPluginId?{onEdit:()=>setSkillEdit(skillDetail)}:{})}/>}
    {migration&&<Modal title="整理旧导入" wide onClose={()=>setMigration(null)} {...(migration.completed?{}:{submit:'迁移组件',onSubmit:async()=>{const r=await call('components.migrate',{token:migration.token});report(`已整理 ${r.skills} 项 Skill、${r.plugins} 个真实插件；恢复记录已保存。`);}})}><p>{migration.completed?'这份来源已完成迁移。':`保留 ${migration.preserved} 个 Skill ID；新增 ${migration.added} 项；共 ${migration.skills} 项 Skill、${migration.plugins} 个真实插件。`}</p><p className="notice">完整目录独立复制；不复制账号凭证、不自动连接 MCP 或运行脚本。受影响的定时计划暂停。</p>{migration.items.map((v,i)=><p key={i}><strong>{v.name}</strong> · {v.skills} 项 Skill<br/><small>{v.reason}</small></p>)}</Modal>}
    {componentPlugin&&management&&!skillDetail&&!skillEdit&&<Modal title={'管理 · '+componentPlugin.name} wide onClose={closeManagement}>
      <div className="plugin-management">
        <div className="plugin-management-summary">
          <ComponentIcon kind="plugin"/>
          <div><p>{componentPlugin.declarations?.apps.length?'此包含宿主应用声明；仅有应用 ID 的服务当前不支持。可移植服务需配置实际 WorkDay MCP 地址和授权。':'目录与资源已复制；所需依赖与运行验证分别进行。'}</p>
            {componentPlugin.declarations?.hooks&&<p>包含 hook 文件；WorkDay 不自动加载或执行。</p>}
          </div>
        </div>
        <section className="plugin-management-section" aria-label="插件 Skill">
          <h3>Skill<span>{managedSkills.length}</span></h3>
          {managedSkills.length ? <div className="plugin-management-skills" role="list" aria-label="插件 Skill 列表">{managedSkills.map(s=><div className="component-row plugin-management-skill" role="listitem" key={s.id}>
            <ComponentIcon kind="skill"/>
            <Hint label={[s.name,componentDescription(s)].filter(Boolean).join('\n')} className="plugin-item-tooltip" interactive><strong className="component-name" tabIndex={0}><span>{s.name}</span><small>已安装指令与资源，依赖未验证</small></strong></Hint>
            <div className="actions"><Button type="button" onClick={()=>setSkillDetailId(s.id)}>查看</Button><Button type="button" disabled={busy||!componentPlugin.enabled} onClick={()=>void run(()=>call('skills.toggle',{id:s.id,expectedVersion:s.version,enabled:!s.enabled}))}>{s.enabled?'停用':'启用'}</Button></div>
          </div>)}</div> : <p className="plugin-management-empty">此插件未包含 Skill</p>}
        </section>
        <section className="plugin-management-section" aria-label="插件 MCP">
          <h3>MCP<span>{managedMcpCount}</span></h3>
          <McpManager key={componentPlugin.id+':'+management.serverId} ownerPluginId={componentPlugin.id} initialServerId={management.serverId} initialConversationId={management.conversationId}/>
        </section>
      </div>
    </Modal>}
    {uninstall&&<Confirm title="卸载 Plugin" submit="卸载此包" onClose={()=>setUninstall(null)} onConfirm={async()=>{await call('plugins.uninstall',{id:uninstall.id,expectedVersion:uninstall.version});setManagement(null);setComponentPluginId(null);}}><p>卸载“{uninstall.name}”及 {uninstall.skillIds.length} 项 Skill、{uninstall.mcpIds.length} 项 MCP。历史保留，相关授权撤销，计划暂停。</p></Confirm>}
  </section>;
}
