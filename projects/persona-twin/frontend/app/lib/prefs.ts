// Client-side user preferences, persisted to localStorage.
// SSR-safe: every accessor guards `window` (the app runs SPA-mode, but the
// no-flash theme bootstrap in root.tsx also reads the same key).

export type Theme = "light" | "dark" | "system";

export interface Prefs {
  theme: Theme;
  defaultPersona: string | null; // persona_id to preselect on the Ask page
  debug: boolean; // show routing & timings by default
}

const KEY = "pt:prefs";
const DEFAULTS: Prefs = { theme: "system", defaultPersona: null, debug: false };

export function loadPrefs(): Prefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  if (typeof window !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(next));
    if (patch.theme !== undefined) applyTheme(next.theme);
    window.dispatchEvent(new CustomEvent("pt:prefs", { detail: next }));
  }
  return next;
}

// Resolve "system" against the OS preference and toggle the `.dark` class.
export function applyTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

// Inline-able snippet for root.tsx <head> so the theme is set before paint
// (no flash of the wrong theme on first load).
export const THEME_BOOTSTRAP = `(function(){try{
var p=JSON.parse(localStorage.getItem('${KEY}')||'{}');var t=p.theme||'system';
var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
