import type { ComponentKind } from '../shared/types';
import skillIcon from './assets/component-icons/skill.png';
import mcpIcon from './assets/component-icons/mcp.png';
import pluginIcon from './assets/component-icons/plugin.png';

const icons: Record<ComponentKind, string> = { skill: skillIcon, mcp: mcpIcon, plugin: pluginIcon };

export function ComponentIcon({ kind }: { kind: ComponentKind }) {
  return <img className="component-icon" src={icons[kind]} alt="" aria-hidden="true" draggable={false} />;
}
