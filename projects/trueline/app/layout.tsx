import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "trueline — invoice line-item verification",
  description:
    "Extract invoice line items, verify the math in code, reconcile against the PO and catalog rates, flag recoverable overcharges, and route to human review. Next.js + Convex + Clerk + LLM.",
};

// Runs before paint: reads localStorage["theme"] (dark|light|system, default
// system honoring prefers-color-scheme) and adds `light` to <html> when the
// resolved theme is light — so there's no flash of the wrong theme on load.
const THEME_BOOTSTRAP = `(function(){try{
var t=localStorage.getItem('theme')||'system';
var light=t==='light'||(t==='system'&&!matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('light',light);}catch(e){}})();`;

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
