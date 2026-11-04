import type { ComponentKind } from '../../shared/types';
import skillIcon from '../skill/assets/icon.png';
import mcpIcon from '../mcp/assets/icon.png';
import pluginIcon from '../plugin/assets/icon.png';

const icons: Record<ComponentKind, string> = { skill: skillIcon, mcp: mcpIcon, plugin: pluginIcon };

export function ComponentIcon({ kind }: { kind: ComponentKind }) {
  return <img className="component-icon" src={icons[kind]} alt="" aria-hidden="true" draggable={false} />;
}
