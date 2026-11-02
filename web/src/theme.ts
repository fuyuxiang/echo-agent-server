import type { ThemeConfig } from 'antd'

// Aligned with echo-agent-desktop/src/styles/tokens.css (light theme).
export const echoColors = {
  canvas: '#fcfdfc',
  sidebar: '#f3f5f3',
  secondary: '#f7f7f7',
  text: '#242927',
  textSecondary: '#505954',
  textMuted: '#5e6762',
  brand: '#00614d',
  brandHover: '#004f3f',
  mint: '#e3f7f2',
  mintHover: '#d4f3eb',
  mintActive: '#c5efe3',
  border: '#e6e9e6',
  controlBorder: '#7b857f',
  success: '#167347',
  warning: '#8a4600',
  error: '#c93032',
  info: '#1267a8',
}

export const echoFontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'

// Share the same palette with authored CSS, including portal content.
export function applyEchoVariables(): void {
  for (const [name, value] of Object.entries(echoColors)) {
    document.documentElement.style.setProperty(`--echo-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value)
  }
  document.documentElement.style.setProperty('--echo-font-family', echoFontFamily)
}

export const echoTheme: ThemeConfig = {
  token: {
    colorPrimary: echoColors.brand,
    colorLink: echoColors.brand,
    colorLinkHover: echoColors.brandHover,
    colorInfo: echoColors.info,
    colorSuccess: echoColors.success,
    colorWarning: echoColors.warning,
    colorError: echoColors.error,
    colorText: echoColors.text,
    colorTextSecondary: echoColors.textSecondary,
    colorTextTertiary: echoColors.textMuted,
    colorBgBase: echoColors.canvas,
    colorBgContainer: echoColors.canvas,
    colorBgLayout: echoColors.canvas,
    colorBorder: echoColors.controlBorder,
    colorBorderSecondary: echoColors.border,
    colorFillAlter: echoColors.secondary,
    fontFamily: echoFontFamily,
    fontSize: 13,
    borderRadius: 8,
    borderRadiusLG: 14,
    controlHeight: 34,
    controlHeightLG: 42,
    boxShadow: '0 2px 8px rgba(18, 30, 28, 0.06)',
    boxShadowSecondary: '0 18px 48px rgba(18, 30, 28, 0.1), 0 2px 8px rgba(18, 30, 28, 0.05)',
  },
  components: {
    Layout: { headerBg: echoColors.canvas, siderBg: echoColors.sidebar, headerHeight: 56 },
    Menu: {
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemColor: echoColors.textSecondary,
      itemHoverBg: '#e9ede9',
      itemSelectedBg: '#e2e6e2',
      itemSelectedColor: echoColors.text,
      groupTitleColor: echoColors.textMuted,
      itemHeight: 36,
      itemBorderRadius: 8,
      iconSize: 16,
    },
    Button: {
      colorPrimary: echoColors.mint,
      colorPrimaryHover: echoColors.mintHover,
      colorPrimaryActive: echoColors.mintActive,
      primaryColor: echoColors.brand,
      primaryShadow: 'none',
      defaultShadow: 'none',
      fontWeight: 500,
    },
    Table: {
      headerBg: echoColors.secondary,
      headerColor: echoColors.textSecondary,
      headerSplitColor: 'transparent',
      borderColor: echoColors.border,
      rowHoverBg: '#f3f8f5',
      cellPaddingBlock: 16,
    },
    Card: { headerFontSize: 14, headerFontSizeSM: 13 },
    Tabs: { titleFontSize: 13, horizontalItemGutter: 28 },
    Tag: { defaultBg: '#f0f3f0', defaultColor: echoColors.textSecondary },
    Modal: { borderRadiusLG: 16 },
    Breadcrumb: { fontSize: 12 },
  },
}
