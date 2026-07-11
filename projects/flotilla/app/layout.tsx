import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "flotilla — staging/preview management",
  description:
    "Provision, refresh, and manage preview/staging app instances across Vercel + Convex + Clerk. Consolidated logs, rollback-safe orchestration, reproducible templates.",
};

// Runs before paint so there's no flash of the wrong appearance on load
// (trueline convention). Reads the persisted prefs and applies them to <html>:
//   • theme      (dark|light|system, default system honoring prefers-color-scheme)
//   • flotilla-accent (indigo default → no attribute; else 9 palette hues)
//   • flotilla-bg   ("off" hides the background image → solid theme)
//   • flotilla-glass (0.35–1 panel translucency → inline --glass-alpha; wins over
//                  the html.no-bg default so an explicit choice always sticks)
//   • flotilla-blur  (0–24px base backdrop blur → inline --glass-blur; the
//                  transparency slider adds an inverse readability boost on top)
//   • flotilla-nav-collapsed ("1" → data-nav-collapsed on <html>; shrinks the
//                  sidebar layout's desktop rail to an icon-only mini rail and
//                  narrows the content offset in lockstep. Default = expanded.)
//   • flotilla-ink / flotilla-surface / flotilla-bgcolor (freeform hex color overrides →
//                  inline --color-ink / --surface-solid / --color-bg; only set
//                  when the operator picked one, else the theme token stands)
// All are applied here so switching tabs / reloading never flashes.
const THEME_BOOTSTRAP = `(function(){try{
var d=document.documentElement;
var t=localStorage.getItem('theme')||'system';
var light=t==='light'||(t==='system'&&!matchMedia('(prefers-color-scheme: dark)').matches);
d.classList.toggle('light',light);
var a=localStorage.getItem('flotilla-accent');
if(a&&a!=='indigo')d.setAttribute('data-accent',a);
var bgOff=localStorage.getItem('flotilla-bg')==='off';
if(bgOff)d.classList.add('no-bg');
// Nav layout — persisted like accent (flotilla-nav). Applied pre-paint as data-nav
// so there's no flash of the wrong nav; unknown/missing → the sidebar default.
// Keep this list in sync with lib/navLayout.ts NAV_LAYOUTS / DEFAULT_NAV_LAYOUT.
var nv=localStorage.getItem('flotilla-nav');
d.setAttribute('data-nav',(nv==='sidebar'||nv==='grouped'||nv==='overflow'||nv==='horizontal')?nv:'sidebar');
// Sidebar collapse — persisted like nav-layout (flotilla-nav-collapsed). Applied
// pre-paint as data-nav-collapsed="1" so the mini rail (icon-only, w-14) and the
// matching narrow content offset render on first paint with no flash. Absent
// attribute = expanded (the default). Only "1" opts in; anything else clears it.
// Keep in sync with lib/navCollapsed.ts.
if(localStorage.getItem('flotilla-nav-collapsed')==='1')d.setAttribute('data-nav-collapsed','1');
else d.removeAttribute('data-nav-collapsed');
// Preload only the ACTIVE theme's AVIF background (CSS-referenced images are
// discovered late, after CSS parse). We know the theme here (pre-paint) so we
// emit exactly one preload for the visible theme — never both — and skip it
// entirely when the background is turned off. type=image/avif lets the browser
// drop the hint if it can't decode AVIF (it'll then negotiate via image-set).
if(!bgOff){var l=document.createElement('link');l.rel='preload';l.as='image';l.type='image/avif';l.href=light?'/bg-light.avif':'/bg-dark.avif';document.head.appendChild(l);}
var g=parseFloat(localStorage.getItem('flotilla-glass'));
if(g>=0.35&&g<=1)d.style.setProperty('--glass-alpha',String(g));
var b=parseFloat(localStorage.getItem('flotilla-blur'));
if(b>=0&&b<=24)d.style.setProperty('--glass-blur',b+'px');
var ink=localStorage.getItem('flotilla-ink');if(ink)d.style.setProperty('--color-ink',ink);
var sf=localStorage.getItem('flotilla-surface');if(sf)d.style.setProperty('--surface-solid',sf);
var bgc=localStorage.getItem('flotilla-bgcolor');if(bgc)d.style.setProperty('--color-bg',bgc);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
