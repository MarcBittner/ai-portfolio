import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Grimoire — an offline-first knowledge base for AI",
  description:
    "Grimoire is an offline-first, self-hostable knowledge base for AI: sign in, read a curated library, keep your own notes. Markdown is the source of truth; WYSIWYG + raw editing, RBAC, per-user spaces, and RAG search. Next.js + Clerk + MongoDB.",
};

// Runs before paint so there's no flash of the wrong appearance on load. Reads
// the persisted prefs and applies them to <html>:
//   • theme          (dark|light|system, default dark honoring prefers-color-scheme)
//   • docs-accent    (indigo default → no attribute; else 9 palette hues)
//   • docs-bg        ("off" hides the background image → solid theme)
//   • docs-glass     (0.35–1 panel translucency → inline --glass-alpha; wins over
//                     the html.no-bg default so an explicit choice always sticks)
//   • docs-blur      (0–24px base backdrop blur → inline --glass-blur)
//   • docs-ink / docs-surface / docs-bgcolor (freeform hex overrides → inline
//                     --color-ink / --surface-solid / --color-bg; only set when
//                     the operator picked one, else the theme token stands)
// All are applied here so switching pages / reloading never flashes.
const THEME_BOOTSTRAP = `(function(){try{
var d=document.documentElement;
var t=localStorage.getItem('theme')||'dark';
var light=t==='light'||(t==='system'&&!matchMedia('(prefers-color-scheme: dark)').matches);
d.classList.toggle('light',light);
var a=localStorage.getItem('docs-accent');
if(a&&a!=='indigo')d.setAttribute('data-accent',a);
if(localStorage.getItem('docs-bg')==='off')d.classList.add('no-bg');
var g=parseFloat(localStorage.getItem('docs-glass'));
if(g>=0.35&&g<=1)d.style.setProperty('--glass-alpha',String(g));
var b=parseFloat(localStorage.getItem('docs-blur'));
if(b>=0&&b<=24)d.style.setProperty('--glass-blur',b+'px');
var ink=localStorage.getItem('docs-ink');if(ink)d.style.setProperty('--color-ink',ink);
var sf=localStorage.getItem('docs-surface');if(sf)d.style.setProperty('--surface-solid',sf);
var bgc=localStorage.getItem('docs-bgcolor');if(bgc)d.style.setProperty('--color-bg',bgc);
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
