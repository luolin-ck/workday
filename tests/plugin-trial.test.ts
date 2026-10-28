import { describe, expect, it } from 'vitest';
import { planPluginTrial } from '../src/renderer/plugin-trial';
import type { Plugin, Skill } from '../src/shared/types';

const base = { id: 'plugin', version: 4, createdAt: '2026-10-26', updatedAt: '2026-10-26' };
const plugin: Plugin = { ...base, pluginKey: 'fixture', name: 'Fixture', description: '', packageVersion: '1.0.0', enabled: true, skillIds: ['one', 'two'], mcpIds: ['server'] };
const skill = (id: string, patch: Partial<Skill> = {}): Skill => ({ ...base, id, version: 7, name: id, description: '', content: 'Fixture instruction', enabled: true, ownerPluginId: plugin.id, ...patch });

describe('Plugin trial context', () => {
  it('carries the single usable Skill and its owning plugin versions into the new chat', () => {
    const result = planPluginTrial(plugin, [skill('one'), skill('two', { enabled: false })]);
    expect(result.needsPicker).toBe(false);
    expect(result.context.skillRef).toEqual({ id: 'one', version: 7 });
    expect(result.context.pluginRefs).toEqual([{ id: 'plugin', version: 4, skillId: 'one', mcpRefs: [] }]);
    expect(result.context.mcpRefs).toEqual([]);
  });
  it('opens component choice for multiple usable Skills instead of silently choosing one', () => {
    const result = planPluginTrial(plugin, [skill('one'), skill('two')]);
    expect(result.needsPicker).toBe(true);
    expect(result.context.skillRef).toBeNull();
    expect(result.context.pluginRefs ?? []).toEqual([]);
  });
  it('lets an explicit example select the exact Skill in a multi-Skill plugin', () => {
    expect(planPluginTrial(plugin, [skill('one'), skill('two')], 'two').context.skillRef).toEqual({ id: 'two', version: 7 });
  });
  it('leaves MCP-only trial selection to the existing scoped permission picker', () => {
    const result = planPluginTrial(plugin, []);
    expect(result.needsPicker).toBe(true);
    expect(result.context.mcpRefs).toEqual([]);
    expect(result.context.pluginRefs ?? []).toEqual([]);
  });
  it('rejects a disabled plugin before creating a trial chat', () => {
    expect(() => planPluginTrial({ ...plugin, enabled: false }, [skill('one')])).toThrow('启用');
  });
  it.each([skill('one', { enabled: false }), skill('one', { ownerPluginId: 'other' }), skill('missing')])('rejects an unavailable or foreign explicit Skill $id', candidate => {
    expect(() => planPluginTrial(plugin, [candidate], candidate.id)).toThrow('Skill');
  });
});
