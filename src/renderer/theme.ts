// Theme customization entry point. Sizes are CSS lengths; ratios and weights are unitless strings.
const monoPalette = {
  "text": "#202226",
  "canvas": "#f4f5f7",
  "surface": "#fff",
  "border": "#d4d8de",
  "muted": "#616975",
  "soft-text": "#424b57",
  "faint-text": "#6b7280",
  "mint": "#25272c",
  "mint-dark": "#eceef1",
  "danger": "#a53d2e",
  "priority-p0-text": "#b42318",
  "priority-p0-background": "#fee4e2",
  "priority-p1-text": "#765800",
  "priority-p1-background": "#fff3bf",
  "priority-p2-text": "#175cd3",
  "priority-p2-background": "#dbeafe",
  "accent-ink": "#fff",
  "accent-hover": "#41444c",
  "accent-shadow": "#20222612",
  "accent-divider": "#ffffff40",
  "button": "#f5f6f8",
  "button-hover": "#e9ecf0",
  "border-hover": "#a1a8b2",
  "border-subtle": "#dce0e6",
  "border-strong": "#b5bdc8",
  "input": "#fff",
  "app-surface": "#f3f4f6",
  "app-glow": "#ffffff80",
  "navigation-top": "#ffffffd9",
  "navigation-bottom": "#edf0f5d9",
  "panel-top": "#ffffffeb",
  "panel-bottom": "#fbfcfde0",
  "panel-shadow": "#20222608",
  "surface-subtle": "#f5f6f8",
  "surface-soft": "#eceff3",
  "surface-selected": "#e7eaf0",
  "surface-strong": "#e6eaf0",
  "plugin-hero-start": "#b7c9ee",
  "plugin-hero-end": "#ded5f4",
  "plugin-hero-glow": "#f5f1fd",
  "day-background": "#ffffff66",
  "weekend-background": "#f0f2f6aa",
  "day-hover": "#e9edf2",
  "day-selected": "#e9edf3",
  "day-card": "#f4f5f7",
  "day-card-hover": "#ebeef2",
  "deadline-stripe": "#ffffff99",
  "deadline-underlay": "#64748b1c",
  "rest-text": "#25643b",
  "rest-background": "#e6f3e9",
  "work-text": "#854512",
  "work-background": "#fff0dc",
  "message-background": "#f3f5f8",
  "message-info-background": "#202226",
  "message-info-text": "#f6f7f9",
  "message-info-muted": "#aab1bb",
  "message-info-border": "#41454d",
  "message-info-cache": "#83d69b",
  "composer-background": "#fff",
  "notice-background": "#f3f5ec",
  "notice-border": "#c9d3b4",
  "notice-text": "#475c2c",
  "error-background": "#fff1eb",
  "error-border": "#e4b5a3",
  "error-text": "#8c3821",
  "modal-background": "#fff",
  "modal-backdrop": "#18283c55",
  "modal-shadow": "#18283c33",
  "background-overlay": "#f7f9fb99",
  "image-panel": "#ffffffe0",
  "image-chrome": "#ffffffe0"
};
const bluePalette: Palette = { ...monoPalette,
  "text": "#172b45",
  "canvas": "#eef4fc",
  "border": "#c9d9ef",
  "muted": "#526982",
  "soft-text": "#375577",
  "faint-text": "#61748e",
  "mint": "#1d5fcb",
  "mint-dark": "#e8f0ff",
  "accent-hover": "#164fa9",
  "accent-shadow": "#1d5fcb18",
  "button": "#f2f6ff",
  "button-hover": "#e4eeff",
  "border-hover": "#729bda",
  "border-subtle": "#d5e2f4",
  "border-strong": "#9bb8e2",
  "app-surface": "#eef4fc",
  "app-glow": "#c7ddff66",
  "navigation-top": "#f9fbffd9",
  "navigation-bottom": "#e4eefdd9",
  "panel-bottom": "#f8fbffe0",
  "panel-shadow": "#1d5fcb08",
  "surface-subtle": "#f1f6fe",
  "surface-soft": "#e8f0ff",
  "surface-selected": "#e1ecff",
  "surface-strong": "#e2edff",
  "weekend-background": "#eaf2ff99",
  "day-hover": "#e5efff",
  "day-selected": "#e2ecff",
  "day-card": "#eff5fd",
  "day-card-hover": "#e5efff",
  "message-background": "#f0f5ff",
  "background-overlay": "#eff5fc99",
  "image-chrome": "#f7faffe0"
};

export const themeDefaults = {
  "fontFamily": {
    "body": "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
    "mono": "ui-monospace,SFMono-Regular,Menlo,monospace"
  },
  "fontSize": {
    "micro": "9px",
    "tiny": "10px",
    "xs": "11px",
    "sm": "12px",
    "md": "13px",
    "content": "14px",
    "lg": "15px",
    "xl": "18px",
    "title": "20px",
    "heading": "22px",
    "display": "24px"
  },
  "fontWeight": {
    "medium": "500",
    "semibold": "600",
    "bold": "700"
  },
  "lineHeight": {
    "heading": "1.25",
    "title": "1.35",
    "tight": "1.4",
    "small": "1.45",
    "compact": "1.5",
    "base": "1.55",
    "normal": "1.6",
    "weather": "1.65",
    "relaxed": "1.7",
    "message": "1.75",
    "content": "1.8",
    "empty": "1.9",
    "single": "1",
    "calendarNarrow": "12px",
    "lunar": "15px",
    "count": "16px",
    "banner": "24px",
    "projectSelect": "26px",
    "modelSelect": "30px"
  },
  "letterSpacing": {
    "heading": "-.5px",
    "eyebrow": "1.5px"
  },
  "space": {
    "workspaceGutter": "5px",
    "homeColumnGap": "4px",
    "1": "1px",
    "2": "2px",
    "3": "3px",
    "4": "4px",
    "5": "5px",
    "6": "6px",
    "7": "7px",
    "8": "8px",
    "9": "9px",
    "10": "10px",
    "11": "11px",
    "12": "12px",
    "13": "13px",
    "14": "14px",
    "15": "15px",
    "16": "16px",
    "17": "17px",
    "18": "18px",
    "19": "19px",
    "20": "20px",
    "21": "21px",
    "22": "22px",
    "23": "23px",
    "24": "24px",
    "25": "25px",
    "26": "26px",
    "27": "27px",
    "28": "28px",
    "29": "29px",
    "30": "30px"
  },
  "radius": {
    "tick": "1px",
    "xs": "2px",
    "rail": "3px",
    "sm": "4px",
    "small": "5px",
    "compact": "7px",
    "md": "8px",
    "control": "9px",
    "status": "10px",
    "bubble": "11px",
    "card": "12px",
    "panel": "14px",
    "lg": "16px",
    "xl": "32px",
    "round": "50%"
  },
  "border": {
    "thin": "1px",
    "focus": "2px",
    "focusOffset": "3px"
  },
  "shadow": {
    "button": "0 2px 10px var(--accent-shadow)",
    "navigation": "0 1px 9px var(--accent-shadow)",
    "panel": "0 8px 25px var(--panel-shadow)",
    "day": "inset 0 0 0 2px var(--mint)",
    "tooltip": "0 4px 16px var(--panel-shadow)",
    "composer": "0 2px 8px var(--panel-shadow)",
    "selected": "inset 0 0 0 1px var(--mint)",
    "source": "inset 0 0 0 1px var(--accent-shadow)",
    "modal": "0 24px 90px var(--modal-shadow)",
    "notification": "0 15px 45px var(--modal-shadow)"
  },
  "opacity": {
    "disabled": ".45",
    "secondary": ".6",
    "completed": ".7",
    "weather": ".4"
  },
  "motion": {
    "fast": ".15s",
    "banner": ".6s"
  },
  "mantineRadius": { "xs": "0.125rem", "sm": "0.25rem", "md": "0.5rem", "lg": "1rem", "xl": "2rem" },
  "mantineSpace": { "xs": "0.625rem", "sm": "0.75rem", "md": "1rem", "lg": "1.25rem", "xl": "2rem" },
  "iconSize": {
    "micro": "9px",
    "xs": "12px",
    "sm": "14px",
    "folder": "15px",
    "sidebar": "14px",
    "md": "16px",
    "default": "18px",
    "taskAction": "14px",
    "taskCornerAction": "12px",
    "nav": "20px",
    "empty": "30px"
  },
  // Mantine numeric props originally became rem; keep that scale separate from CSS px geometry.
  "size": {
    "composerAttachmentImage":"68px",
    "messageReadingWidth":"800px",
    "messageUserWidth":"85%",
    "messageAttachmentImage":"80px",
    "messageAttachmentFile":"224px",
    "messageAction":"28px",
    "messageMediaWidth":"640px",
    "messageMediaHeight":"480px",
    "composerAttachmentFile":"208px",
    "composerAttachmentRadius":"10px",
    "composerSuggestionsMaxHeight":"340px",
    "composerSuggestionsLayer":"300",
    "contextChip": "180px",
    "contextChoices": "360px",
    "componentMaterials": "160px",
    "componentFileList": "360px",
    "componentFilePreview": "280px",
    "action": "2.125rem",
    "taskAction": "24px",
    "taskCornerAction": "20px",
    "taskActionSlot": "26px",
    "actionSmall": "1.5rem",
    "actionAdd": "1.625rem",
    "actionToggle": "1.25rem",
    "button": "34px",
    "input": "38px",
    "compactInput": "32px",
    "completionDate": "10rem",
    "settingsSidebar": "200px",
    "settingsControl": "30px",
    "tab": "32px",
    "settingsModelList": "240px",
    "settingsModelCardMin": "180px",
    "settingsModelCardHeight": "44px",
    "skillDetail": "600px",
    "skillDetailHeight": "720px",
    "pluginListRow": "64px",
    "pluginListIcon": "40px",
    "componentIcon": "32px",
    "pluginListAction": "32px",
    "pluginListMenu": "224px",
    "componentActionMenu": "168px",
    "pluginDetail": "720px",
    "pluginDetailIcon": "60px",
    "pluginDetailHero": "224px",
    "pluginDetailPrompt": "500px",
    "pluginDetailFactLabel": "116px",
    "skillTooltipMaxHeight": "24rem",
    "settingsFactLabel": "72px",
    "inlineInput": "28px",
    "taskBadge": "22px",
    "taskInlineBadge": "20px",
    "navButton": "36px",
    "checkbox": "17px",
    "calendarRefresh": "30px",
    "calendarDay": "26px",
    "calendarDayNarrow": "23px",
    "deadlineStripeWidth": "2px",
    "deadlineStripePeriod": "9px",
    "calendarCountIconCompact": "10px",
    "calendarScheduledGrid": "584px",
    "calendarScheduledGridNarrow": "512px",
    "meetingTime": "132px",
    "dayListRow": "44px",
    "emptyTasksArt": "160px",
    "emptyArt": "128px",
    "emptyArtCompact": "64px",
    "weatherArt": "64px",
    "logo": "28px",
    "modal": "28.75rem",
    "modalWide": "45rem",
    "tooltip": "26.25rem",
    "messageInfo": "18rem",
    "projectMenu": "10.625rem",
    "chatMenu": "9.375rem",
    "taskMenu": "15rem",
    "priorityMenu": "6.5rem",
    "taskMenuMaxHeight": "260px",
    "modelMenu": "22rem",
    "modelMenuMaxHeight": "280px"
  }
};
export type Palette = { [K in keyof typeof monoPalette]: string };
export type ThemeTokens = { [Group in keyof typeof themeDefaults]: { [K in keyof typeof themeDefaults[Group]]: string } };
export type ThemeDefinition = {
  name: string;
  description: string;
  colorScheme: 'light' | 'dark';
  palette: Palette;
  tokens?: { [Group in keyof ThemeTokens]?: Partial<ThemeTokens[Group]> };
  preview?: Partial<{ canvas: string; panel: string; border: string; accent: string }>;
};

export const themeConfig = {
  defaultTheme: 'mono' as const,
  themes: {
    mono: { name: '黑白', description: '白色背景，黑灰文字', colorScheme: 'light', palette: monoPalette },
    blue: { name: '蓝白', description: '白色背景，蓝色强调', colorScheme: 'light', palette: bluePalette },
    custom: { name: '自定义', description: '调整公共变量', colorScheme: 'light', palette: monoPalette }
  }
} satisfies { defaultTheme: string; themes: Record<string, ThemeDefinition> };
export type ThemeId = keyof typeof themeConfig.themes;
export const themes = (Object.entries(themeConfig.themes) as [ThemeId, ThemeDefinition][])
  .map(([id, { name, description }]) => ({ id, name, description }));

export function resolveTheme(definition: ThemeDefinition) {
  // Every switch starts from all defaults, so an override cannot leak into the next theme.
  const tokens = Object.fromEntries(Object.entries(themeDefaults).map(([group, defaults]) =>
    [group, { ...defaults, ...definition.tokens?.[group as keyof ThemeTokens] }])) as ThemeTokens;
  return { ...definition, tokens, preview: {
    canvas: definition.palette['app-surface'], panel: definition.palette.surface,
    border: definition.palette.border, accent: definition.palette.mint, ...definition.preview
  } };
}
export type ResolvedTheme = ReturnType<typeof resolveTheme>;
type ColorField = { key: string; label: string; type: 'color'; default: string; targets: (keyof Palette)[] };
type ScaleField = { key: string; label: string; type: 'number'; default: number; min: number; max: number; step: number; groups: (keyof ThemeTokens)[] };
// The editable schema is shared by validation, UI and token mapping. No arbitrary CSS input.
export const customThemeFields = [
  { key: 'canvas', label: '工作台底色', type: 'color', default: '#f4f5f7', targets: ['canvas', 'app-surface'] },
  { key: 'surface', label: '面板色', type: 'color', default: '#ffffff', targets: ['surface', 'panel-top', 'panel-bottom', 'navigation-top', 'navigation-bottom', 'input', 'composer-background', 'modal-background', 'image-panel', 'image-chrome'] },
  { key: 'text', label: '正文色', type: 'color', default: '#202226', targets: ['text', 'soft-text'] },
  { key: 'muted', label: '次级文字色', type: 'color', default: '#616975', targets: ['muted', 'faint-text'] },
  { key: 'accent', label: '强调色', type: 'color', default: '#25272c', targets: ['mint', 'accent-hover', 'border-hover'] },
  { key: 'border', label: '边框色', type: 'color', default: '#d4d8de', targets: ['border', 'border-subtle', 'border-strong'] },
  { key: 'card', label: '事项卡片色', type: 'color', default: '#f4f5f7', targets: ['day-card', 'day-card-hover'] },
  { key: 'fontScale', label: '字号比例', type: 'number', default: 1, min: .85, max: 1.25, step: .05, groups: ['fontSize'] },
  { key: 'spacingScale', label: '间距比例', type: 'number', default: 1, min: .75, max: 1.25, step: .05, groups: ['space', 'mantineSpace'] },
  { key: 'radiusScale', label: '圆角比例', type: 'number', default: 1, min: 0, max: 1.5, step: .1, groups: ['radius', 'mantineRadius'] }
] as const satisfies readonly (ColorField | ScaleField)[];
export type CustomTheme = { [F in typeof customThemeFields[number] as F['key']]: F['type'] extends 'color' ? string : number };
export const defaultCustomTheme = Object.fromEntries(customThemeFields.map(field => [field.key, field.default])) as CustomTheme;
export function parseCustomTheme(value: unknown): CustomTheme | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some(key => !customThemeFields.some(field => field.key === key))) return null;
  const result = { ...defaultCustomTheme };
  for (const field of customThemeFields) {
    const input = candidate[field.key];
    if (input === undefined) continue;
    if (field.type === 'color') {
      if (typeof input !== 'string' || !/^#[0-9a-f]{6}$/i.test(input)) return null;
      result[field.key] = input.toLowerCase();
    } else {
      if (typeof input !== 'number' || !Number.isFinite(input) || input < field.min || input > field.max) return null;
      result[field.key] = input;
    }
  }
  return result;
}
export function getTheme(id: ThemeId, custom: Partial<CustomTheme> = {}) {
  const resolved = resolveTheme(themeConfig.themes[id]);
  if (id !== 'custom') return resolved;
  const config = parseCustomTheme(custom);
  if (!config) throw new Error('自定义主题变量无效，请检查颜色或数值范围');
  resolved.palette = { ...resolved.palette };
  for (const field of customThemeFields) {
    if (field.type === 'color') {
      for (const key of field.targets) resolved.palette[key] = config[field.key];
    } else {
      for (const group of field.groups) {
        const tokens = resolved.tokens[group] as Record<string, string>;
        for (const [key, value] of Object.entries(tokens)) {
          const match = /^(\d*\.?\d+)(px|rem)$/.exec(value);
          if (match) tokens[key] = `${Number((Number(match[1]) * config[field.key]).toFixed(4))}${match[2]}`;
        }
      }
    }
  }
  resolved.preview = { canvas: resolved.palette['app-surface'], panel: resolved.palette.surface, border: resolved.palette.border, accent: resolved.palette.mint };
  return resolved;
}

const prefixes: Record<keyof ThemeTokens, string> = {
  fontFamily: 'font', fontSize: 'text', fontWeight: 'weight', lineHeight: 'line', letterSpacing: 'tracking',
  space: 'space', radius: 'radius', border: 'border-width', shadow: 'shadow', opacity: 'opacity',
  motion: 'motion', iconSize: 'icon', size: 'size', mantineRadius: 'component-radius', mantineSpace: 'component-space'
};
export function themeVariables(theme: ResolvedTheme): Record<`--${string}`, string> {
  const variables: Record<`--${string}`, string> = { '--color-scheme': theme.colorScheme };
  for (const [name, value] of Object.entries(theme.palette)) variables[`--${name}`] = value;
  for (const group of Object.keys(prefixes) as (keyof ThemeTokens)[]) {
    for (const [name, value] of Object.entries(theme.tokens[group])) variables[`--${prefixes[group]}-${name}`] = value;
  }
  return variables;
}
export function previewVariables(id: ThemeId, custom: Partial<CustomTheme> = {}): Record<`--${string}`, string> {
  return Object.fromEntries(Object.entries(getTheme(id, custom).preview).map(([key, value]) => [`--preview-${key}`, value]));
}
