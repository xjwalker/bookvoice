import { AppTheme } from './types';

export interface Theme {
  name: AppTheme;
  statusBar: 'light-content' | 'dark-content';
  // Backgrounds
  bg: string;
  surface: string;
  surfaceDeep: string;
  // Text
  textPrimary: string;
  textSecondary: string;
  textDim: string;
  textMuted: string;
  // Reader area
  readerBg: string;
  readerText: string;
  readerTextDim: string;
  // Borders / separators
  border: string;
  // Overlay
  overlay: string;
}

const DARK: Theme = {
  name: 'dark',
  statusBar: 'light-content',
  bg: '#0a0a0f',
  surface: '#1a1a24',
  surfaceDeep: '#111118',
  textPrimary: '#f0ebe0',
  textSecondary: '#888',
  textDim: '#555',
  textMuted: '#444',
  readerBg: '#0a0a0f',
  readerText: '#c8c0b0',
  readerTextDim: '#7a7060',
  border: '#1a1a24',
  overlay: 'rgba(0,0,0,0.6)',
};

const DIM: Theme = {
  name: 'dim',
  statusBar: 'light-content',
  bg: '#1a1a24',
  surface: '#24243a',
  surfaceDeep: '#1e1e30',
  textPrimary: '#d4ccbc',
  textSecondary: '#888',
  textDim: '#666',
  textMuted: '#555',
  readerBg: '#1a1a24',
  readerText: '#d4ccbc',
  readerTextDim: '#8a8070',
  border: '#2a2a3a',
  overlay: 'rgba(0,0,0,0.6)',
};

const LIGHT: Theme = {
  name: 'light',
  statusBar: 'dark-content',
  bg: '#f5f0e8',
  surface: '#ffffff',
  surfaceDeep: '#ede8e0',
  textPrimary: '#2c2c2c',
  textSecondary: '#666',
  textDim: '#999',
  textMuted: '#bbb',
  readerBg: '#ffffff',
  readerText: '#2c2c2c',
  readerTextDim: '#666',
  border: '#e0dbd0',
  overlay: 'rgba(0,0,0,0.4)',
};

const SEPIA: Theme = {
  name: 'sepia',
  statusBar: 'dark-content',
  bg: '#fdf6e3',
  surface: '#fff8ee',
  surfaceDeep: '#f0e8d4',
  textPrimary: '#3c3c3c',
  textSecondary: '#777',
  textDim: '#aaa',
  textMuted: '#ccc',
  readerBg: '#fff8ee',
  readerText: '#3c3c3c',
  readerTextDim: '#777',
  border: '#e8e0cc',
  overlay: 'rgba(0,0,0,0.35)',
};

const THEMES: Record<AppTheme, Theme> = { dark: DARK, dim: DIM, light: LIGHT, sepia: SEPIA };

export function getTheme(name: AppTheme): Theme {
  return THEMES[name] ?? DARK;
}

export const THEME_OPTIONS: { key: AppTheme; label: string }[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'dim', label: 'Dim' },
  { key: 'light', label: 'Light' },
  { key: 'sepia', label: 'Sepia' },
];
