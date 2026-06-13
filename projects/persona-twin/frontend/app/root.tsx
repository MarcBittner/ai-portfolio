import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { THEME_BOOTSTRAP } from "./lib/prefs";

export const meta: Route.MetaFunction = () => [
  { title: "persona-twin" },
  {
    name: "description",
    content: "Query RAG-grounded digital twins of synthetic personas",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="h-full bg-background text-foreground antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <main className="mx-auto max-w-3xl p-8 text-muted-foreground">
      loading personas…
    </main>
  );
}

export default function App() {
  return <Outlet />;
}
