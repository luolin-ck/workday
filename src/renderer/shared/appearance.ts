import { themes, themeConfig, getTheme, themeVariables, defaultCustomTheme, parseCustomTheme, type CustomTheme, type ThemeId } from './theme';
import type { AppearanceStorage } from './appearance-storage';
export const APPEARANCE_KEY = 'workday.appearance';
export { themes } from './theme';
export type Appearance = { theme: ThemeId; custom: CustomTheme; background: Blob | null };
export type AppearancePatch = Partial<Appearance>;
export const defaultAppearance = (): Appearance => ({ theme: themeConfig.defaultTheme, custom: { ...defaultCustomTheme }, background: null });
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];

export function parseAppearance(value: unknown): Appearance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some(key => !['theme', 'custom', 'background'].includes(key)) || !themes.some(theme => theme.id === candidate.theme)) return null;
  const custom = parseCustomTheme(candidate.custom ?? {});
  if (!custom || (candidate.background !== null && (!(candidate.background instanceof Blob) || !candidate.background.size || !imageTypes.includes(candidate.background.type)))) return null;
  return { theme: candidate.theme as ThemeId, custom, background: candidate.background as Blob | null };
}

export async function readBackground(file: Blob): Promise<Blob> {
  if (!imageTypes.includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (!file.size) throw new Error('图片内容为空，请重新选择');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = String.fromCharCode(...bytes);
  const valid = file.type === 'image/png' ? text.startsWith('\x89PNG\r\n\x1a\n') : file.type === 'image/jpeg' ? text.startsWith('\xff\xd8\xff') : text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
  if (!valid) throw new Error('图片内容与格式不符，请重新选择');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty image');
    return file;
  } catch { throw new Error('图片无法打开，请选择有效图片'); }
  finally { URL.revokeObjectURL(url); }
}

async function readLegacy(storage: Pick<Storage, 'getItem'>): Promise<Appearance> {
  const raw: unknown = JSON.parse(storage.getItem(APPEARANCE_KEY) ?? 'null');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultAppearance();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['theme', 'background'].includes(key)) || !['forest', 'mono', 'blue'].includes(String(value.theme))) throw new Error('旧外观配置无效');
  let background: Blob | null = null;
  if (value.background !== null) {
    if (typeof value.background !== 'string') throw new Error('旧背景图片无效');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.background);
    if (!match || match[2].length % 4 !== 0) throw new Error('旧背景图片无效');
    const binary = atob(match[2]);
    background = await readBackground(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1] }));
  }
  return { ...defaultAppearance(), theme: value.theme === 'forest' ? 'mono' : value.theme as ThemeId, background };
}

export async function readAppearance(storage: AppearanceStorage, legacy: Pick<Storage, 'getItem' | 'removeItem'>): Promise<{ appearance: Appearance; error?: string }> {
  let appearance = defaultAppearance();
  let readCompleted = false;
  try {
    const record = await storage.read();
    readCompleted = true;
    if (record !== undefined) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('外观记录无效，原记录已保留');
      const { schemaVersion, ...value } = record as Record<string, unknown>;
      const parsed = schemaVersion === 1 ? parseAppearance(value) : null;
      if (!parsed) throw new Error('外观记录版本或内容无效，原记录已保留');
      if (parsed.background) await readBackground(parsed.background);
      return { appearance: parsed };
    }
    appearance = await readLegacy(legacy);
    await saveAppearance(storage, appearance);
    try { legacy.removeItem(APPEARANCE_KEY); } catch { /* The committed DB always takes precedence. */ }
    return { appearance };
  } catch (error) {
    // When opening the DB fails, still recover the legacy view without overwriting it.
    if (!readCompleted) {
      try { appearance = await readLegacy(legacy); } catch { /* Invalid input stays untouched. */ }
    }
    return { appearance, error: `${error instanceof Error ? error.message : '外观设置读取失败'}；原设置保留。` };
  }
}

export async function saveAppearance(storage: AppearanceStorage, value: Appearance): Promise<void> {
  const validated = parseAppearance(value);
  if (!validated) throw new Error('主题或背景图片无效');
  try { await storage.write({ schemaVersion: 1, ...validated }); }
  catch { throw new Error('外观设置保存失败，请检查本机存储空间；原设置保留。'); }
}

export function applyAppearance(root: HTMLElement, value: Appearance, backgroundUrl: string | null = null) {
  root.dataset.theme = value.theme;
  for (const [name, token] of Object.entries(themeVariables(getTheme(value.theme, value.custom)))) root.style.setProperty(name, token);
  if (backgroundUrl) {
    root.dataset.background = 'true';
    root.style.setProperty('--background-image', `url("${backgroundUrl}")`);
  } else {
    delete root.dataset.background;
    root.style.removeProperty('--background-image');
  }
}
