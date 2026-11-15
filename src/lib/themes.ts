/** 全部主题：id 与 CSS 的 :root[data-theme=...] 对应 */
export interface ThemeDef {
  id: string;
  label: string;
  /** 主题预览色（底色、强调色） */
  swatch: [string, string];
  dark: boolean;
}

export const THEMES: ThemeDef[] = [
  { id: 'dark', label: '经典深色', swatch: ['#0e1015', '#7c6cff'], dark: true },
  { id: 'light', label: '清爽浅色', swatch: ['#f5f6fa', '#7c6cff'], dark: false },
  { id: 'sea', label: '深海之蓝', swatch: ['#0c1620', '#5b9fc4'], dark: true },
  { id: 'forest', label: '松林绿', swatch: ['#0f1712', '#6fbf8f'], dark: true },
  { id: 'sunset', label: '暮色暖橘', swatch: ['#1a130e', '#df9a6e'], dark: true },
  { id: 'sakura', label: '樱粉物语', swatch: ['#faf3f5', '#c97a97'], dark: false },
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));

export function normalizeTheme(v: string | null | undefined): string {
  return v && THEME_IDS.has(v) ? v : 'dark';
}
