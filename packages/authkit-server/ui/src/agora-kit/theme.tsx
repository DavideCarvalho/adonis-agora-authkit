import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState>({
  theme: 'dark',
  setTheme: () => {},
  toggle: () => {},
});

function readStored(key: string): Theme | undefined {
  try {
    const value = window.localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

function initialTheme(key: string, fallback: Theme): Theme {
  if (typeof window === 'undefined') return fallback;
  return readStored(key) ?? fallback;
}

/** Apply a theme to `<html>`: the `light` class and `data-theme` (both, so either selector works). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
}

/**
 * Light/dark theme for one console, remembered per console in localStorage (every access in
 * try/catch: private windows and blocked storage just fall back to `defaultTheme`). `accent` is the
 * console's one brand hue — written to `--agora-accent` on `<html>` (CSSOM, so it is CSP-safe).
 */
export function ThemeProvider({
  children,
  storageKey,
  accent,
  defaultTheme = 'dark',
}: {
  children: ReactNode;
  /** e.g. `'agora-durable-theme'`: one key per console. */
  storageKey: string;
  /** The console accent (`#a3e635`). Omit to keep whatever the stylesheet sets. */
  accent?: string;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme(storageKey, defaultTheme));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (accent && typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--agora-accent', accent);
    }
  }, [accent]);

  const setTheme = useCallback(
    (next: Theme) => {
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.classList.add('agora-theme-switching');
        window.setTimeout(() => root.classList.remove('agora-theme-switching'), 260);
      }
      setThemeState(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        /* storage blocked: the choice lasts for this page only */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    [theme, setTheme],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
