"use client";

import { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";

import { cn } from "./ui";

// ---- appearance settings (theme · background · accent · transparency · blur) --
// Ported from the instance-dashboard. The swatch is the DARK-theme accent value
// from globals.css so each chip shows its true hue; picking one sets
// `data-accent` on <html> and the CSS palette (html[data-accent=…]) recolors
// buttons, nav, links, focus, glass, … coherently in both themes. Selections are
// persisted to localStorage (docs-* keys) and re-applied before paint by the
// bootstrap in layout.tsx, so there's no flash on reload. Order follows the wheel.
const ACCENTS: { id: string; label: string; swatch: string }[] = [
  { id: "indigo", label: "Indigo", swatch: "oklch(0.72 0.13 250)" }, // default
  { id: "blue", label: "Blue", swatch: "oklch(0.72 0.15 245)" },
  { id: "teal", label: "Teal", swatch: "oklch(0.78 0.12 195)" },
  { id: "green", label: "Green", swatch: "oklch(0.78 0.15 150)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.80 0.15 74)" },
  { id: "orange", label: "Orange", swatch: "oklch(0.74 0.16 46)" },
  { id: "rose", label: "Rose", swatch: "oklch(0.70 0.17 15)" },
  { id: "violet", label: "Violet", swatch: "oklch(0.70 0.16 300)" },
  { id: "purple", label: "Purple", swatch: "oklch(0.68 0.17 322)" },
  { id: "pink", label: "Pink", swatch: "oklch(0.73 0.16 350)" },
];

// Transparency slider bounds — drive `--glass-alpha` (see globals.css .glass).
const GLASS_MIN = 0.35; // very see-through
const GLASS_MAX = 1; // solid
const GLASS_DEFAULT = 0.62; // matches the @theme --glass-alpha

// Blur slider bounds — drive `--glass-blur`, the BASE backdrop blur on the
// glass surfaces. 0 = crisp, 24 = heavy frost; default matches the @theme value.
const BLUR_MIN = 0;
const BLUR_MAX = 24;
const BLUR_DEFAULT = 8; // matches the @theme --glass-blur default

// Freeform color overrides — text (ink), the glass panel base, and the page
// background. Stored as hex in localStorage and applied inline on <html> so they
// win over the theme's --color-* tokens and stick across theme/background
// toggles (cleared by Reset). Empty string = use theme default.
const COLOR_KEYS = { ink: "docs-ink", surface: "docs-surface", bg: "docs-bgcolor" } as const;
const COLOR_DEFAULTS = {
  ink: { dark: "#f1f0ec", light: "#3b3f46" },
  surface: { dark: "#33363b", light: "#fcfcfd" },
  bg: { dark: "#14161c", light: "#eff0f2" },
} as const;
const readStoredColor = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  // The bootstrap in layout.tsx already applied the persisted prefs to <html>
  // before paint. We lazily reflect that DOM state into the menu's control state
  // — this only drives which segment/swatch reads as active, and the menu is
  // closed on first render, so there's no hydration-visible mismatch.
  const readDom = <T,>(fn: (d: HTMLElement) => T, fallback: T): T =>
    typeof document === "undefined" ? fallback : fn(document.documentElement);
  const [theme, setThemeState] = useState<"dark" | "light">(() =>
    readDom((d) => (d.classList.contains("light") ? "light" : "dark"), "dark"),
  );
  const [bgOn, setBgOn] = useState(() => readDom((d) => !d.classList.contains("no-bg"), true));
  const [accent, setAccentState] = useState(() =>
    readDom((d) => d.getAttribute("data-accent") ?? "indigo", "indigo"),
  );
  const [glass, setGlassState] = useState(() =>
    readDom((d) => {
      const v = parseFloat(getComputedStyle(d).getPropertyValue("--glass-alpha"));
      return Number.isFinite(v) ? Math.min(GLASS_MAX, Math.max(GLASS_MIN, v)) : GLASS_DEFAULT;
    }, GLASS_DEFAULT),
  );
  const [blur, setBlurState] = useState(() =>
    readDom((d) => {
      const v = parseFloat(getComputedStyle(d).getPropertyValue("--glass-blur"));
      return Number.isFinite(v) ? Math.min(BLUR_MAX, Math.max(BLUR_MIN, v)) : BLUR_DEFAULT;
    }, BLUR_DEFAULT),
  );
  const [ink, setInkState] = useState(() => readStoredColor(COLOR_KEYS.ink));
  const [surface, setSurfaceState] = useState(() => readStoredColor(COLOR_KEYS.surface));
  const [bgColor, setBgColorState] = useState(() => readStoredColor(COLOR_KEYS.bg));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const setTheme = (next: "dark" | "light") => {
    document.documentElement.classList.toggle("light", next === "light");
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
    setThemeState(next);
  };
  const setBg = (on: boolean) => {
    document.documentElement.classList.toggle("no-bg", !on);
    try {
      localStorage.setItem("docs-bg", on ? "on" : "off");
    } catch {
      /* ignore */
    }
    setBgOn(on);
  };
  const setAccent = (id: string) => {
    const d = document.documentElement;
    if (id === "indigo") d.removeAttribute("data-accent");
    else d.setAttribute("data-accent", id);
    try {
      localStorage.setItem("docs-accent", id);
    } catch {
      /* ignore */
    }
    setAccentState(id);
  };
  const setGlass = (v: number) => {
    const clamped = Math.min(GLASS_MAX, Math.max(GLASS_MIN, v));
    // Inline style wins over the `html.no-bg { --glass-alpha }` rule, so an
    // explicit choice sticks even in solid-background mode.
    document.documentElement.style.setProperty("--glass-alpha", String(clamped));
    try {
      localStorage.setItem("docs-glass", String(clamped));
    } catch {
      /* ignore */
    }
    setGlassState(clamped);
  };
  const setBlur = (v: number) => {
    const clamped = Math.min(BLUR_MAX, Math.max(BLUR_MIN, Math.round(v)));
    document.documentElement.style.setProperty("--glass-blur", `${clamped}px`);
    try {
      localStorage.setItem("docs-blur", String(clamped));
    } catch {
      /* ignore */
    }
    setBlurState(clamped);
  };
  // Apply a freeform color override: set the CSS var inline on <html> (wins over
  // the theme token), persist the hex, reflect it in the swatch.
  const applyColor = (key: string, cssVar: string, hex: string, setState: (v: string) => void) => {
    document.documentElement.style.setProperty(cssVar, hex);
    try {
      localStorage.setItem(key, hex);
    } catch {
      /* ignore */
    }
    setState(hex);
  };
  const setInk = (hex: string) => applyColor(COLOR_KEYS.ink, "--color-ink", hex, setInkState);
  const setSurface = (hex: string) =>
    applyColor(COLOR_KEYS.surface, "--surface-solid", hex, setSurfaceState);
  const setBgColor = (hex: string) => applyColor(COLOR_KEYS.bg, "--color-bg", hex, setBgColorState);

  // Reset to shipped defaults: dark · indigo · image background · default
  // translucency/blur · theme colors. Clears the persisted keys AND updates the
  // DOM live (no reload).
  const resetAll = () => {
    const d = document.documentElement;
    d.classList.remove("light");
    d.classList.remove("no-bg");
    d.removeAttribute("data-accent");
    d.style.removeProperty("--glass-alpha");
    d.style.removeProperty("--glass-blur");
    d.style.removeProperty("--color-ink");
    d.style.removeProperty("--surface-solid");
    d.style.removeProperty("--color-bg");
    for (const k of [
      "theme",
      "docs-bg",
      "docs-accent",
      "docs-glass",
      "docs-blur",
      COLOR_KEYS.ink,
      COLOR_KEYS.surface,
      COLOR_KEYS.bg,
    ]) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    setThemeState("dark");
    setBgOn(true);
    setAccentState("indigo");
    setGlassState(GLASS_DEFAULT);
    setBlurState(BLUR_DEFAULT);
    setInkState("");
    setSurfaceState("");
    setBgColorState("");
  };

  const segBtn = (on: boolean) =>
    cn(
      "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
      on
        ? "bg-[--color-accent]/20 text-[--color-ink]"
        : "text-[--color-muted] hover:text-[--color-ink]",
    );

  const colorRow = (
    label: string,
    val: string,
    def: { dark: string; light: string },
    onPick: (hex: string) => void,
  ) => (
    <label className="flex items-center justify-between gap-2 text-xs text-[--color-muted]">
      <span>{label}</span>
      <input
        type="color"
        aria-label={`${label} color`}
        value={val || (theme === "light" ? def.light : def.dark)}
        onChange={(e) => onPick(e.target.value)}
        className="h-6 w-10 cursor-pointer rounded border border-[--color-line] bg-transparent p-0"
      />
    </label>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Appearance settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md p-1.5 text-[--color-muted] transition-colors hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
          open && "bg-[--color-accent]/10 text-[--color-ink]",
        )}
      >
        <Palette size={16} aria-hidden />
      </button>
      {open && (
        <div className="glass absolute right-0 z-50 mt-2 w-56 p-3 text-sm shadow-xl">
          <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Theme
          </div>
          <div className="mb-3 flex gap-1 rounded-md border border-[--color-line] p-0.5">
            <button type="button" className={segBtn(theme === "dark")} onClick={() => setTheme("dark")}>
              Dark
            </button>
            <button
              type="button"
              className={segBtn(theme === "light")}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
          </div>

          <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Background
          </div>
          <div className="mb-3 flex gap-1 rounded-md border border-[--color-line] p-0.5">
            <button type="button" className={segBtn(bgOn)} onClick={() => setBg(true)}>
              Image
            </button>
            <button type="button" className={segBtn(!bgOn)} onClick={() => setBg(false)}>
              Solid
            </button>
          </div>

          <div className="mb-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Accent
          </div>
          <div className="grid grid-cols-5 gap-2">
            {ACCENTS.map((a) => {
              const on = accent === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  title={a.label}
                  aria-label={a.label}
                  aria-pressed={on}
                  onClick={() => setAccent(a.id)}
                  className={cn(
                    "mx-auto h-6 w-6 rounded-full ring-offset-2 ring-offset-[--color-surface] transition-transform hover:scale-110",
                    on ? "ring-2 ring-[--color-ink]" : "ring-1 ring-[--color-line]",
                  )}
                  style={{ background: a.swatch }}
                />
              );
            })}
          </div>

          <div className="mb-1.5 mt-3 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            <span>Transparency</span>
            <span className="tabular-nums">{Math.round(glass * 100)}%</span>
          </div>
          <input
            type="range"
            aria-label="Panel transparency"
            min={GLASS_MIN}
            max={GLASS_MAX}
            step={0.01}
            value={glass}
            onChange={(e) => setGlass(parseFloat(e.target.value))}
            className="docs-range w-full"
          />
          <div className="mt-0.5 flex justify-between text-[0.62rem] text-[--color-muted]">
            <span>Clear</span>
            <span>Solid</span>
          </div>

          <div className="mb-1.5 mt-3 flex items-center justify-between text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            <span>Blur</span>
            <span className="tabular-nums">{Math.round(blur)}px</span>
          </div>
          <input
            type="range"
            aria-label="Panel blur"
            min={BLUR_MIN}
            max={BLUR_MAX}
            step={1}
            value={blur}
            onChange={(e) => setBlur(parseFloat(e.target.value))}
            className="docs-range w-full"
          />
          <div className="mt-0.5 flex justify-between text-[0.62rem] text-[--color-muted]">
            <span>Crisp</span>
            <span>Frosted</span>
          </div>

          <div className="mb-1.5 mt-3 text-[0.7rem] font-medium uppercase tracking-wide text-[--color-muted]">
            Colors
          </div>
          <div className="space-y-1.5">
            {colorRow("Text", ink, COLOR_DEFAULTS.ink, setInk)}
            {colorRow("Glass panel", surface, COLOR_DEFAULTS.surface, setSurface)}
            {colorRow("Background", bgColor, COLOR_DEFAULTS.bg, setBgColor)}
          </div>

          <button
            type="button"
            onClick={resetAll}
            className="mt-3 w-full rounded-md border border-[--color-line] px-2 py-1.5 text-xs font-medium text-[--color-muted] transition-colors hover:border-[--color-accent] hover:text-[--color-ink]"
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
