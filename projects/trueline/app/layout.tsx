import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "trueline — invoice line-item verification",
  description:
    "Extract invoice line items, verify the math in code, reconcile against the PO and catalog rates, flag recoverable overcharges, and route to human review. Next.js + Convex + Clerk + LLM.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
