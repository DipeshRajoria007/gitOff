import { useSyncExternalStore } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'ogh.theme';
const listeners = new Set<() => void>();

function read(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** Primer's CSS themes key off these attributes on <html>. */
export function applyTheme(mode: ThemeMode = read()) {
  const el = document.documentElement;
  el.setAttribute('data-color-mode', mode);
  el.setAttribute('data-light-theme', 'light');
  el.setAttribute('data-dark-theme', 'dark');
}

export function setTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
  listeners.forEach((l) => l());
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
}

/** Primer React's name for the same setting. */
export const primerColorMode = (m: ThemeMode) => (m === 'light' ? 'day' : m === 'dark' ? 'night' : 'auto');
