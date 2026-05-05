// Tiny theme helper: read/write `acme-theme` in localStorage and toggle
// `data-theme="dark"` on the <html> element. The CSS in `index.css` listens
// for that attribute via `html[data-theme="dark"]`.

export type Theme = "light" | "dark";

const STORAGE_KEY = "acme-theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "light";
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode, etc.) — non-fatal.
  }
}
