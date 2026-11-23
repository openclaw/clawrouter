import type { Theme } from "./ui-types";

const themeStorageKey = "clawrouter-theme";

export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch { /* storage can be unavailable in privacy-restricted contexts */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0c0e11" : "#f2f0ea");
  try { window.localStorage.setItem(themeStorageKey, theme); } catch { /* preference still applies for this page */ }
}

const initialTheme = readTheme();
applyTheme(initialTheme);
