import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { componentTheme } from '../src/renderer/component-theme';
import { applyAppearance, defaultAppearance, parseAppearance } from '../src/renderer/appearance';
import { getTheme, previewVariables, resolveTheme, themeConfig, themeDefaults, themes, themeVariables, type ThemeDefinition } from '../src/renderer/theme';

const css = readFileSync(new URL('../src/renderer/style.css', import.meta.url), 'utf8');

describe('theme configuration consumers', () => {
  it('registers preferences, color schemes and previews from the same definitions', () => {
    expect(themes.map(t => t.id)).toEqual(Object.keys(themeConfig.themes));
    for (const { id, name } of themes) {
      const theme = getTheme(id);
      expect(theme.name).toBe(name);
      expect(parseAppearance({ theme: id, background: null })?.theme).toBe(id);
      expect(themeVariables(theme)['--color-scheme']).toBe(theme.colorScheme);
      expect(previewVariables(id)).toEqual(Object.fromEntries(Object.entries(theme.preview).map(([k,v]) => [`--preview-${k}`,v])));
      expect(Object.keys(theme.palette).sort()).toEqual(Object.keys(getTheme('mono').palette).sort());
    }
    expect(themeConfig.defaultTheme in themeConfig.themes).toBe(true);
  });

  it('provides every application CSS variable without invalid variable media queries', () => {
    const variables = themeVariables(getTheme(themeConfig.defaultTheme));
    const local = new Set(['--background-image', '--icon-size', '--preview-canvas', '--preview-panel', '--preview-border', '--preview-accent']);
    for (const name of css.matchAll(/var\((--[\w-]+)/g)) expect(name[1] in variables || local.has(name[1]), name[1]).toBe(true);
    expect(css).not.toMatch(/@(?:media|container)[^{]*var\(/);
    expect(css).not.toMatch(/--(?:text|canvas|surface|preview-canvas):#[\da-f]/i);
    expect(css).not.toMatch(/font-size:\d/);
  });

  it('resolves a new theme and non-color overrides without mutating defaults or leaking between switches', () => {
    const custom: ThemeDefinition = {
      ...themeConfig.themes.mono, name: '定制', colorScheme: 'dark',
      palette: { ...themeConfig.themes.mono.palette, mint: '#8855aa', surface: '#fdf5ff' },
      tokens: { fontSize: { sm: '16px' }, radius: { md: '12px' }, size: { action: '42px' }, space: { 8: '10px' } }
    };
    const values = themeVariables(resolveTheme(custom));
    expect(values['--text-sm']).toBe('16px');
    expect(values['--radius-md']).toBe('12px');
    expect(values['--size-action']).toBe('42px');
    expect(values['--space-8']).toBe('10px');
    expect(values['--text-md']).toBe(themeDefaults.fontSize.md);
    expect(resolveTheme(custom).preview.accent).toBe('#8855aa');
    const original = themeVariables(getTheme('mono'));
    expect(original['--text-sm']).toBe('12px');
    expect(original['--size-action']).toBe('2.125rem');
    const stored = new Map(Object.entries(values));
    const root = { dataset: {}, style: { setProperty: (key: string, value: string) => stored.set(key, value), removeProperty: (key: string) => stored.delete(key) } };
    applyAppearance(root as unknown as HTMLElement, defaultAppearance());
    for (const [key,value] of Object.entries(original)) expect(stored.get(key), key).toBe(value);
  });

  it('keeps Mantine and application controls bound to live CSS tokens', () => {
    const values = themeVariables(getTheme('blue'));
    for (const group of [componentTheme.fontSizes, componentTheme.radius, componentTheme.spacing, componentTheme.lineHeights]) {
      for (const value of Object.values(group ?? {})) {
        const variable = /var\((--[\w-]+)\)/.exec(String(value))?.[1];
        expect(variable && values[variable as keyof typeof values], String(value)).toBeTruthy();
      }
    }
    expect(componentTheme.fontFamily).toBe('var(--font-body)');
    expect(componentTheme.components?.ActionIcon?.defaultProps?.size).toBe('var(--size-action)');
    expect(css).toContain('grid-auto-columns:max(var(--size-taskActionSlot),var(--size-taskAction))');
    expect(css).toContain('font-size:var(--text-sm)');
    expect(css).toContain('border-radius:var(--radius-md)');
  });
});
