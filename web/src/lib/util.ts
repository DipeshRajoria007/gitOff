import { useCallback, useState } from 'react';

export function timeAgo(iso?: string | null): string {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const shortSha = (oid?: string | null) => (oid ? oid.slice(0, 7) : '');

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function labelColors(hex: string): { background: string; color: string; borderColor: string } {
  const h = (hex || '888888').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    background: `#${h}`,
    color: lum > 0.6 ? '#1f2328' : '#ffffff',
    borderColor: lum > 0.85 ? 'var(--borderColor-default)' : 'transparent',
  };
}

export function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/** useState that survives reloads. */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage full or disabled */
      }
    },
    [key],
  );
  return [value, set];
}
