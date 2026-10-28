import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_KEY, applyAppearance, defaultAppearance, parseAppearance, readAppearance, readBackground, saveAppearance, themes } from '../src/renderer/appearance';
import { createAppearanceStorage, type AppearanceStorage } from '../src/renderer/appearance-storage';
import { defaultCustomTheme, parseCustomTheme } from '../src/renderer/theme';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const pngBlob = () => new Blob([Buffer.from(png.split(',')[1], 'base64')], { type: 'image/png' });
function memory(initial?: unknown) {
  let record = initial;
  return { read: vi.fn(async () => record), write: vi.fn(async (value: unknown) => { record = value; }) };
}
const legacy = (value: unknown = null) => ({ getItem: vi.fn(() => value === null ? null : JSON.stringify(value)), removeItem: vi.fn() });
beforeEach(() => vi.stubGlobal('Image', class { src = ''; naturalWidth = 1; naturalHeight = 1; decode = async () => {}; }));
afterEach(() => vi.unstubAllGlobals());

describe('atomic local appearance preferences', () => {
  it('round trips every theme, custom config and original Blob in one record', async () => {
    for (const theme of themes) {
      const value = { theme: theme.id, custom: { ...defaultCustomTheme, accent: '#7c3aed' }, background: pngBlob() };
      const storage = memory(); await saveAppearance(storage, value);
      expect(storage.write).toHaveBeenCalledWith({ schemaVersion: 1, ...value });
      expect((await readAppearance(storage, legacy())).appearance).toEqual(value);
    }
  });
  it('migrates forest to mono with the old background only after a committed write', async () => {
    const storage = memory(), old = legacy({ theme: 'forest', background: png });
    const result = await readAppearance(storage, old);
    expect(result.error).toBeUndefined(); expect(result.appearance.theme).toBe('mono');
    expect(await result.appearance.background?.text()).toBe(await pngBlob().text());
    expect(old.removeItem).toHaveBeenCalledWith(APPEARANCE_KEY);
    expect(storage.write.mock.invocationCallOrder[0]).toBeLessThan(old.removeItem.mock.invocationCallOrder[0]);
  });
  it('keeps the legacy appearance and source when migration commit fails', async () => {
    const storage: AppearanceStorage = { read: async () => undefined, write: async () => { throw Error('abort'); } };
    const old = legacy({ theme: 'blue', background: png });
    const result = await readAppearance(storage, old);
    expect(result.appearance.theme).toBe('blue'); expect(result.appearance.background?.size).toBe(pngBlob().size);
    expect(result.error).toContain('原设置保留'); expect(old.removeItem).not.toHaveBeenCalled();
  });
  it('never resurrects an old preference after a committed record, even if cleanup fails', async () => {
    const storage = memory(), old = legacy({ theme: 'forest', background: png });
    old.removeItem.mockImplementation(() => { throw Error('disabled'); });
    expect((await readAppearance(storage, old)).error).toBeUndefined();
    await saveAppearance(storage, { ...defaultAppearance(), theme: 'custom' });
    const result = await readAppearance(storage, old);
    expect(result.appearance.theme).toBe('custom'); expect(result.appearance.background).toBeNull();
    expect(old.getItem).toHaveBeenCalledTimes(1);
  });
  it('recovers the legacy view if opening IndexedDB fails', async () => {
    const result = await readAppearance({ read: async () => { throw Error('open failed'); }, write: vi.fn() }, legacy({ theme: 'blue', background: png }));
    expect(result.appearance.theme).toBe('blue'); expect(result.error).toContain('open failed');
  });
  it.each([null, {}, { schemaVersion: 2, ...defaultAppearance() }, { schemaVersion: 1, ...defaultAppearance(), background: 'https://example.com/photo.png' }])('preserves damaged or future records without reading stale localStorage', async record => {
    const storage = memory(record), old = legacy({ theme: 'blue', background: png });
    const result = await readAppearance(storage, old);
    expect(result.error).toBeTruthy(); expect(result.appearance).toEqual(defaultAppearance());
    expect(storage.write).not.toHaveBeenCalled(); expect(old.getItem).not.toHaveBeenCalled();
  });
  it('uses safe defaults for no preference', async () => {
    expect((await readAppearance(memory(), legacy())).appearance).toEqual(defaultAppearance());
  });
  it('preserves current storage on a failed write and rejects unknown fields', async () => {
    const previous = { schemaVersion: 1, ...defaultAppearance(), background: pngBlob() };
    const storage = memory(previous); storage.write.mockRejectedValueOnce(Error('quota'));
    await expect(saveAppearance(storage, { ...defaultAppearance(), theme: 'blue' })).rejects.toThrow('原设置保留');
    expect(await storage.read()).toBe(previous);
    await expect(saveAppearance(storage, { ...defaultAppearance(), custom: { ...defaultCustomTheme, accent: 'url(bad)' } })).rejects.toThrow('无效');
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(parseAppearance({ ...defaultAppearance(), injected: true })).toBeNull();
  });
  it('clears only background CSS when removed and restores all preset tokens after custom', () => {
    const values = new Map<string, string>();
    const root = { dataset: {} as Record<string,string>, style: { setProperty: (k:string,v:string) => values.set(k,v), removeProperty: (k:string) => values.delete(k) } };
    applyAppearance(root as unknown as HTMLElement, { ...defaultAppearance(), theme: 'custom', custom: { ...defaultCustomTheme, fontScale: 1.2 } }, 'blob:local');
    expect(root.dataset.background).toBe('true'); expect(values.get('--text-sm')).toBe('14.4px');
    applyAppearance(root as unknown as HTMLElement, defaultAppearance());
    expect(root.dataset).toEqual({ theme: 'mono' }); expect(values.has('--background-image')).toBe(false); expect(values.get('--text-sm')).toBe('12px');
  });
});

describe('fixed custom schema', () => {
  it.each([{ accent: 'url(x)' }, { accent: '#fff;bad' }, { fontScale: Infinity }, { fontScale: 0 }, { spacingScale: 2 }, { radiusScale: -1 }, { script: 'x' }, [], null])('rejects unsafe, unknown or out-of-range settings: %o', value => expect(parseCustomTheme(value)).toBeNull());
  it('fills omitted defaults and normalizes hex without touching the baseline', () => {
    expect(parseCustomTheme({ accent: '#AA00FF', radiusScale: 0 })).toEqual({ ...defaultCustomTheme, accent: '#aa00ff', radiusScale: 0 });
    expect(defaultCustomTheme.accent).toBe('#25272c');
  });
});

describe('background validation and resource lifetime', () => {
  it.each([new Blob(['<svg/>'], { type: 'image/svg+xml' }), new Blob([], { type: 'image/png' }), new Blob(['not png'], { type: 'image/png' }), new Blob([Buffer.from(png.split(',')[1], 'base64')], { type: 'image/jpeg' })])('rejects unsupported, empty or forged files', async blob => {
    await expect(readBackground(blob)).rejects.toThrow();
  });
  it('releases the temporary URL on successful decode and failed decode', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const file = pngBlob(); expect(await readBackground(file)).toBe(file); expect(revoke).toHaveBeenCalledTimes(1);
    vi.stubGlobal('Image', class { src = ''; decode = async () => { throw Error('bad image'); }; });
    await expect(readBackground(file)).rejects.toThrow('图片无法打开'); expect(revoke).toHaveBeenCalledTimes(2);
    revoke.mockRestore();
  });
});

describe('native transaction boundary', () => {
  it('does not treat request success as commit, and reports a subsequent abort', async () => {
    const tx = { objectStore: () => ({ put: () => request }), oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void) };
    const request = { result: 'current', onsuccess: null as null | (() => void) };
    const close = vi.fn(); const db = { transaction: () => tx, close };
    const open = { result: db, onsuccess: null as null | (() => void) };
    const storage = createAppearanceStorage({ open: () => open } as unknown as IDBFactory);
    let settled = false; const pending = storage.write(defaultAppearance()).then(() => { settled = true; });
    const assertion = expect(pending).rejects.toThrow('原设置保留');
    open.onsuccess!(); await new Promise(resolve => setTimeout(resolve, 0)); request.onsuccess!(); await Promise.resolve();
    expect(settled).toBe(false); tx.onabort!(); await assertion; expect(close).toHaveBeenCalledOnce();
  });
});
