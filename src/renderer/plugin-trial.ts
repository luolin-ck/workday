import { emptyContext, type Plugin, type Skill } from '../shared/types';

export function planPluginTrial(plugin: Plugin, skills: Skill[], skillId?: string) {
  if (!plugin.enabled) throw new Error('请先启用插件。');
  const available = skills.filter(skill => skill.enabled && skill.ownerPluginId === plugin.id && plugin.skillIds.includes(skill.id));
  const selected = skillId ? available.find(skill => skill.id === skillId) : available.length === 1 ? available[0] : undefined;
  if (skillId && !selected) throw new Error('所选 Skill 已停用或不属于此插件。');
  return { context: { ...emptyContext(), ...(selected ? {
    skillRef: { id: selected.id, version: selected.version },
    pluginRefs: [{ id: plugin.id, version: plugin.version, skillId: selected.id, mcpRefs: [] }],
  } : {}) }, needsPicker: !selected };
}

const pickerIntents = new Map<string, string>();
const pickerListeners = new Map<string, Set<() => void>>();
export function preparePluginPicker(conversationId: string, pluginId: string) {
  pickerIntents.set(conversationId, pluginId);
  pickerListeners.get(conversationId)?.forEach(listener => listener());
}
export function subscribePluginPicker(conversationId: string | null, listener: () => void) {
  if (!conversationId) return () => {};
  const listeners = pickerListeners.get(conversationId) ?? new Set<() => void>();
  listeners.add(listener);
  pickerListeners.set(conversationId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) pickerListeners.delete(conversationId);
  };
}
export function takePluginPicker(conversationId: string | null) {
  if (!conversationId) return null;
  const id = pickerIntents.get(conversationId) ?? null;
  pickerIntents.delete(conversationId);
  return id;
}

let managementIntent: { pluginId: string; conversationId: string | null } | null = null;
export function preparePluginManagement(pluginId: string, conversationId: string | null) { managementIntent = { pluginId, conversationId }; }
export function takePluginManagement() { const intent = managementIntent; managementIntent = null; return intent; }
