import { afterEach, describe, expect, it, vi } from 'vitest';
import * as theme from '../src/renderer/theme';
import { readBackground } from '../src/renderer/appearance';

afterEach(() => vi.unstubAllGlobals());
describe('runtime custom theme requirements', () => {
  it('offers only black/white, blue/white and custom, with black/white as the default', () => {
    expect(theme.themes.map(value => value.id)).toEqual(['mono', 'blue', 'custom']);
    expect(theme.themeConfig.defaultTheme).toBe('mono');
  });
  it('applies custom color, type, spacing and rounding without changing preset baselines', () => {
    const before = JSON.stringify(theme.themeDefaults);
    const values = theme.themeVariables((theme.getTheme as Function)('custom', { accent: '#7c3aed', fontScale: 1.2, spacingScale: 1.1, radiusScale: 1.5 }));
    expect(values['--mint']).toBe('#7c3aed');
    expect(values['--text-sm']).toBe('14.4px');
    expect(values['--space-8']).toBe('8.8px');
    expect(values['--radius-md']).toBe('12px');
    expect(values['--component-radius-md']).toBe('0.75rem');
    expect(theme.themeVariables(theme.getTheme('mono'))['--text-sm']).toBe('12px');
    expect(JSON.stringify(theme.themeDefaults)).toBe(before);
  });
  it('accepts decoded raster files larger than 5 MB and above forty million pixels', async () => {
    vi.stubGlobal('Image', class { naturalWidth = 10000; naturalHeight = 5000; src = ''; decode = async () => {}; });
    const bytes = new Uint8Array(6 * 1024 * 1024); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], 'large.png', { type: 'image/png' });
    await expect(readBackground(file)).resolves.toBe(file);
  });
});
