import { ActionIcon, Button, Checkbox, createTheme, Input, MantineProvider, Tooltip, type CSSVariablesResolver } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Appearance } from './appearance';
import { getTheme } from './theme';

export const componentTheme = createTheme({
  fontFamily: 'var(--font-body)',
  fontFamilyMonospace: 'var(--font-mono)',
  lineHeights: { xs: 'var(--line-tight)', sm: 'var(--line-small)', md: 'var(--line-base)', lg: 'var(--line-normal)', xl: 'var(--line-weather)' },
  fontSizes: { xs: 'var(--text-xs)', sm: 'var(--text-sm)', md: 'var(--text-md)', lg: 'var(--text-lg)', xl: 'var(--text-xl)' },
  radius: { xs: 'var(--component-radius-xs)', sm: 'var(--component-radius-sm)', md: 'var(--component-radius-md)', lg: 'var(--component-radius-lg)', xl: 'var(--component-radius-xl)' },
  spacing: { xs: 'var(--component-space-xs)', sm: 'var(--component-space-sm)', md: 'var(--component-space-md)', lg: 'var(--component-space-lg)', xl: 'var(--component-space-xl)' },
  defaultRadius: 'md',
  components: {
    Button: Button.extend({ defaultProps: { size: 'sm', variant: 'default' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { size: 'var(--size-action)', variant: 'subtle', color: 'var(--soft-text)' } }),
    Input: Input.extend({ defaultProps: { size: 'sm' } }),
    Checkbox: Checkbox.extend({ defaultProps: { size: 'sm', color: 'var(--mint)', iconColor: 'var(--accent-ink)' } }),
    Tooltip: Tooltip.extend({ defaultProps: { color: 'var(--text)' } })
  }
});
const palette = {
    '--mantine-color-text': 'var(--text)', '--mantine-color-body': 'var(--canvas)',
    '--mantine-color-placeholder': 'var(--faint-text)', '--mantine-color-dimmed': 'var(--muted)',
    '--mantine-color-default': 'var(--button)', '--mantine-color-default-hover': 'var(--button-hover)',
    '--mantine-color-default-color': 'var(--text)', '--mantine-color-default-border': 'var(--border)',
    '--mantine-primary-color-filled': 'var(--mint)', '--mantine-primary-color-filled-hover': 'var(--accent-hover)',
    '--mantine-primary-color-light': 'var(--surface-selected)', '--mantine-primary-color-light-color': 'var(--mint)'
};
const cssVariablesResolver: CSSVariablesResolver = () => ({ variables: palette, light: palette, dark: palette });
export function WorkDayProvider({ appearance, children }: { appearance: Appearance['theme']; children: ReactNode }) {
  return <MantineProvider theme={componentTheme} forceColorScheme={getTheme(appearance).colorScheme} cssVariablesResolver={cssVariablesResolver}>{children}</MantineProvider>;
}
