import { ActionIcon, Button, Menu, UnstyledButton } from '@mantine/core';
import type { McpServer, Plugin, Skill } from '../shared/types';
import { ComponentIcon } from './ComponentIcon';
import { Icon } from './icons';
import { Hint } from './ui';
import { componentDescription } from '../shared/component-description';

export interface PluginDetailProps {
  plugin: Plugin;
  skills: Skill[];
  servers: McpServer[];
  busy: boolean;
  error?: string;
  onBack: () => void;
  onManage: () => void;
  onUninstall: () => void;
  onToggle: () => void;
  onOpenSkill: (skill: Skill) => void;
  onOpenMcp: (server: McpServer) => void;
  onTry: (skill?: Skill, prompt?: string) => void;
}

export function PluginDetail({ plugin, skills, servers, busy, error, onBack, onManage, onUninstall,
  onToggle, onOpenSkill, onOpenMcp, onTry }: PluginDetailProps) {
  const examples = skills.slice(0, 3);
  const capabilities = [...skills.map(skill => skill.name), ...servers.map(server => server.name)];
  const description = componentDescription(plugin);
  return <article className="plugin-detail-page" aria-label={`${plugin.name} 插件详情`}>
    <Button className="plugin-detail-back" variant="subtle" leftSection={<Icon name="chevron-left" size="sm" />}
      onClick={onBack} disabled={busy}>返回插件</Button>
    <header className="plugin-detail-header">
      <span className="plugin-detail-logo"><ComponentIcon kind="plugin" /></span>
      <div className="plugin-detail-heading-row">
        <div className="plugin-detail-heading-copy">
          <Hint label={plugin.name}><h1 tabIndex={0}>{plugin.name}</h1></Hint>
          {!plugin.enabled && <span className="plugin-detail-state">已停用</span>}
        </div>
        <div className="plugin-detail-actions">
          <Menu position="bottom-end" withinPortal width="var(--size-pluginListMenu)">
            <Menu.Target><ActionIcon type="button" aria-label="Plugin 更多操作" disabled={busy}>
              <Icon name="ellipsis" size="md" />
            </ActionIcon></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={onToggle} disabled={busy}>{plugin.enabled ? '停用插件' : '启用插件'}</Menu.Item>
              <Menu.Divider />
              <Menu.Item color="var(--danger)" leftSection={<Icon name="trash" size="sm" />} onClick={onUninstall} disabled={busy}>卸载插件</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Button type="button" leftSection={<Icon name="settings" size="sm" />} onClick={onManage} disabled={busy}>管理</Button>
          <Button type="button" className="primary" leftSection={<Icon name="messages-square" size="sm" />}
            onClick={() => onTry()} disabled={busy || !plugin.enabled}>立即试用</Button>
        </div>
      </div>
    </header>

    {examples.length > 0 && <section className="plugin-detail-examples" aria-label="试用提示">
      {examples.map(skill => {
        const prompt = `使用 ${skill.name} 帮我完成一项任务。`;
        return <UnstyledButton key={skill.id} type="button" className="plugin-detail-example"
          disabled={busy || !plugin.enabled || !skill.enabled} onClick={() => onTry(skill, prompt)} aria-label={`试用 ${skill.name}`}>
          <ComponentIcon kind="skill" />
          <span className="plugin-detail-example-copy">{prompt}</span>
          <span className="plugin-detail-example-arrow"><Icon name="arrow-right" size="sm" /></span>
        </UnstyledButton>;
      })}
    </section>}

    {description && <p className="plugin-detail-description">{description}</p>}
    {error && <p className="error plugin-detail-error" role="alert">{error}</p>}

    {skills.length > 0 && <section className="plugin-detail-section" aria-labelledby="plugin-detail-skills-title">
      <h2 id="plugin-detail-skills-title">技能 <span>{skills.length}</span></h2>
      <div className="plugin-detail-components" role="list">
        {skills.map(skill => <div role="listitem" key={skill.id}>
          <Hint label={[skill.name, componentDescription(skill)].filter(Boolean).join('\n')} interactive>
            <UnstyledButton type="button" className="plugin-detail-component" onClick={() => onOpenSkill(skill)}
              disabled={busy} aria-label={`查看 Skill ${skill.name}`}>
              <span className="plugin-detail-component-icon"><ComponentIcon kind="skill" /></span>
              <span className="plugin-detail-component-copy"><span>{skill.name}</span><span>{componentDescription(skill) || 'Skill'}</span></span>
              {!skill.enabled && <span className="plugin-detail-component-status">已停用</span>}
              <Icon name="chevron-right" size="sm" />
            </UnstyledButton>
          </Hint>
        </div>)}
      </div>
    </section>}

    {servers.length > 0 && <section className="plugin-detail-section" aria-labelledby="plugin-detail-mcp-title">
      <h2 id="plugin-detail-mcp-title">MCP <span>{servers.length}</span></h2>
      <div className="plugin-detail-components" role="list">
        {servers.map(server => <div role="listitem" key={server.id}>
          <Hint label={server.name}>
            <UnstyledButton type="button" className="plugin-detail-component" onClick={() => onOpenMcp(server)}
              disabled={busy} aria-label={`管理 MCP ${server.name}`}>
              <span className="plugin-detail-component-icon"><ComponentIcon kind="mcp" /></span>
              <span className="plugin-detail-component-copy"><span>{server.name}</span><span>{server.transport === 'http' ? 'HTTP 连接' : '本地连接'}</span></span>
              <span className="plugin-detail-component-status">{server.enabled ? '已启用' : '未启用'}</span>
              <Icon name="chevron-right" size="sm" />
            </UnstyledButton>
          </Hint>
        </div>)}
      </div>
    </section>}

    <section className="plugin-detail-section" aria-labelledby="plugin-detail-info-title">
      <h2 id="plugin-detail-info-title">信息</h2>
      <dl className="plugin-detail-facts">
        {capabilities.length > 0 && <div><dt>功能</dt><dd>{capabilities.join('、')}</dd></div>}
        <div><dt>标识</dt><dd>{plugin.pluginKey}</dd></div>
        <div><dt>版本</dt><dd>{plugin.versionDeclared === false ? '未声明' : plugin.packageVersion}</dd></div>
      </dl>
    </section>
  </article>;
}
