# trueline — Complete Code Walkthrough

A file-by-file walkthrough of the trueline application, ordered by execution flow.
Each numbered section covers one file or concept with a code excerpt, numbered notes,
and a summary line. Concept boxes define framework concepts where they first
apply: server vs. client components, hydration, JWT verification, variable scope,
and the Convex function types.

Companion documents: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (system design) and
[`DEPLOYMENT.md`](./DEPLOYMENT.md) (hosting and environment), and [`API.md`](./API.md) (the function API). This document covers
runtime behavior — what executes, and in what order, during normal use.

**Design principle.** The language model only reads the invoice into structured
data; deterministic code performs every calculation and flag decision. The sections
below identify where the codebase enforces that boundary.

**Paths.** All paths are relative to the project root `projects/trueline/`. This
file is in `projects/trueline/docs/`, so `../convex/reconcile.ts` refers to the
source tree one level up. Each section links its source file(s); the source map below
lists every file and the sections it covers.

---

## Summary

The LLM reads, deterministic code decides, the database is multi-tenant and
reactive, and every layer degrades gracefully to a working, testable, zero-cost
fallback.

## FAQ

**How is the LLM prevented from inventing numbers?** It only extracts;
[`reconcile.ts`](../convex/lib/reconcile.ts) recomputes every total in code, so the
model's output is only ever *input* to deterministic checks ([§21](#21-the-trust-critical-core-reconcileline)).

**Actions aren't transactional — how is data not corrupted when one re-runs?** The
write is keyed on the invoice `_id`, and `insertReconciledLines` clears existing
lines before re-inserting, with all writes batched into one `writeResults` mutation
([§17](#17-branch-b-the-server-action-extractrun), [§20](#20-reconcile--write-writeresults--insertreconciledlines)).

**How does a cloud-hosted app use a model running on a local machine?** Browser→host
Ollama: the cloud backend can't reach `localhost`, but the browser can — it extracts
locally and posts the structured lines via `submitExtraction` ([§16](#16-branch-a-browserhost-ollama)).

---

## Source map

**Frontend — [`app/`](../app)** (Next.js App Router; runs in the browser unless noted)

| File | What it is | Sections |
|---|---|---|
| [`middleware.ts`](../middleware.ts) | the auth gate (runs before every route) | §2 |
| [`app/layout.tsx`](../app/layout.tsx) | root shell + theme bootstrap (server) | §3 |
| [`app/providers.tsx`](../app/providers.tsx) | Clerk + Convex client — the client boundary | §4 |
| [`app/page.tsx`](../app/page.tsx) | marketing landing (server component) | §5, §6 |
| [`app/app/page.tsx`](../app/app/page.tsx) | workspace dashboard + upload flow | §8, §12–§16, §22 |
| [`app/app/invoices/[id]/page.tsx`](../app/app/invoices/%5Bid%5D/page.tsx) | per-invoice review table | §23 |
| [`app/app/settings/page.tsx`](../app/app/settings/page.tsx) | routing-config UI | §25 |
| [`app/app/diagnostics/page.tsx`](../app/app/diagnostics/page.tsx) | traces, event log, benchmark | §26 |
| [`app/app/evals/page.tsx`](../app/app/evals/page.tsx) | eval UI | §27 |
| [`app/lib/ollama.ts`](../app/lib/ollama.ts) | browser-side Ollama client | §16 |
| [`app/components/ui.tsx`](../app/components/ui.tsx) | `usd`, `FlagBadge`, `StatusBadge` | §28 |
| [`app/components/nav.tsx`](../app/components/nav.tsx) | app nav + theme toggle | §28 |

**Backend — [`convex/`](../convex)** (DB + functions; runs in Convex Cloud)

| File | What it is | Sections |
|---|---|---|
| [`convex/schema.ts`](../convex/schema.ts) | tables + indexes (the data model) | §11 |
| [`convex/auth.config.ts`](../convex/auth.config.ts) | which JWT issuer Convex trusts | §7 |
| [`convex/invoices.ts`](../convex/invoices.ts) | queries + mutations (the workhorse) | §9, §10, §15, §20, §24 |
| [`convex/extract.ts`](../convex/extract.ts) | the extract **action** (external LLM I/O) | §17 |
| [`convex/routing.ts`](../convex/routing.ts) | per-tenant routing config | §25 |
| [`convex/evals.ts`](../convex/evals.ts) | flag precision/recall scoring | §27 |
| [`convex/diagnostics.ts`](../convex/diagnostics.ts) | the benchmark action | §26 |
| [`convex/lib/llm.ts`](../convex/lib/llm.ts) | provider routing + extraction | §18, §19 |
| [`convex/lib/reconcile.ts`](../convex/lib/reconcile.ts) | the decision engine (pure, money) | §21 |
| [`convex/lib/parse.ts`](../convex/lib/parse.ts) | pipe parser + shared types | §19 |
| [`convex/lib/demoData.ts`](../convex/lib/demoData.ts) | seed PO/catalog/invoices + eval labels | §10 |

**Config & docs**

| File | What it is | Sections |
|---|---|---|
| [`next.config.ts`](../next.config.ts) | Next build config | §29 |
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | the system view | — |
| [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) | how it's hosted (the three planes) | §29 |

---

## Contents

**Part 1 — The framework skeleton (how Next.js boots a request)**
- [1. How files become URLs (the App Router)](#1-how-files-become-urls-the-app-router)
- [2. `middleware.ts` runs before every request](#2-middlewarets-runs-before-every-request)
- [3. `app/layout.tsx`, the shell that wraps every page](#3-applayouttsx-the-shell-that-wraps-every-page)
- [Concept — Hydration, and the hydration mismatch](#concept--hydration-and-the-hydration-mismatch)
- [4. `app/providers.tsx`, the client boundary + live connections](#4-appproviderstsx-the-client-boundary--live-connections)
- [Concept — Module scope vs component scope](#concept--module-scope-vs-component-scope)
- [Concept — Server Components vs Client Components](#concept--server-components-vs-client-components)
- [5. `app/page.tsx`, the landing page (a Server Component)](#5-apppagetsx-the-landing-page-a-server-component)

**Part 2 — Identity (signing in)**
- [6. Clicking "Sign in": the Clerk flow](#6-clicking-sign-in-the-clerk-flow)
- [Concept — How a JWT works](#concept--how-a-jwt-works)
- [7. `auth.config.ts`: how Convex decides to trust the JWT](#7-authconfigts-how-convex-decides-to-trust-the-jwt)

**Part 3 — Landing in the workspace + the data model**
- [8. `/app` mounts and fires live queries](#8-app-mounts-and-fires-live-queries)
- [Concept — Convex query / mutation / action](#concept--convex-query--mutation--action)
- [9. The backend reads: `optionalOrg`, `requireOrg`, multi-tenancy](#9-the-backend-reads-optionalorg-requireorg-multi-tenancy)
- [10. Seeding an empty account (`seedIfEmpty`)](#10-seeding-an-empty-account-seedifempty)
- [11. The data model (`schema.ts`) — the read/decide split, in tables](#11-the-data-model-schemats--the-readdecide-split-in-tables)

**Part 4 — The core codepath: upload → verdict**
- [12. The guided stepper UI](#12-the-guided-stepper-ui)
- [13. Uploading a file (the browser side)](#13-uploading-a-file-the-browser-side)
- [14. `uploadInvoice` decides which route extraction takes](#14-uploadinvoice-decides-which-route-extraction-takes)
- [15. `createInvoiceFromText` mutation (one transaction)](#15-createinvoicefromtext-mutation-one-transaction)
- [16. Branch A: browser→host Ollama](#16-branch-a-browserhost-ollama)
- [17. Branch B: the server action (`extract.run`)](#17-branch-b-the-server-action-extractrun)
- [18. Provider routing (`llm.ts` → `extractLineItems`)](#18-provider-routing-llmts--extractlineitems)
- [19. Parsing messy model output (`parse.ts`, coerce, loose JSON)](#19-parsing-messy-model-output-parsets-coerce-loose-json)
- [20. Reconcile + write (`writeResults` → `insertReconciledLines`)](#20-reconcile--write-writeresults--insertreconciledlines)
- [21. The trust-critical core (`reconcileLine`)](#21-the-trust-critical-core-reconcileline)
- [22. The verdict pushes back to the UI (reactivity)](#22-the-verdict-pushes-back-to-the-ui-reactivity)

**Part 5 — Human review, configuration, evaluation**
- [23. The invoice detail / review page](#23-the-invoice-detail--review-page)
- [24. `reviewLine` and `correctLine` (an edit re-reconciles)](#24-reviewline-and-correctline-an-edit-re-reconciles)
- [25. Routing config (Settings page + `routing.ts`)](#25-routing-config-settings-page--routingts)
- [26. Diagnostics (traces, event log, model benchmark)](#26-diagnostics-traces-event-log-model-benchmark)
- [27. Evals (the CI gate, `evals.ts`)](#27-evals-the-ci-gate-evalsts)

**Part 6 — The shared pieces + the big picture**
- [28. Shared UI (`ui.tsx`, `nav.tsx`)](#28-shared-ui-uitsx-navtsx)
- [29. Build & deploy: the three planes](#29-build--deploy-the-three-planes)
- [30. The whole machine, end to end](#30-the-whole-machine-end-to-end)

---

# Part 1 — The framework skeleton

## 1. How files become URLs (the App Router)

**Files:** the [`app/`](../app) directory tree · [`middleware.ts`](../middleware.ts) · [`app/providers.tsx`](../app/providers.tsx)

trueline uses the Next.js **App Router** (the `app/` directory). The precise rule:
the URL path is the **chain of folder names** from `app/` down, and the leaf folder
must contain a file named exactly **`page.tsx`** to be a routable page.

| File | URL it serves |
|---|---|
| `app/page.tsx` | `/` (marketing landing) |
| `app/app/page.tsx` | `/app` (workspace dashboard) |
| `app/app/invoices/[id]/page.tsx` | `/app/invoices/<anything>` |
| `app/app/settings/page.tsx` | `/app/settings` |
| `app/app/evals/page.tsx` | `/app/evals` |
| `app/app/diagnostics/page.tsx` | `/app/diagnostics` |
| `app/app/about/page.tsx` | `/app/about` |

### What "file-based routing" actually means

A common misread is "there's a file literally named after the path." Not quite — the
**folders** are named after the path segments, and `page.tsx` is a *reserved
filename* that marks "this folder is a renderable page." The filename `page.tsx`
never changes; the **folder names** encode the path:

```
app/app/invoices/[id]/page.tsx
    └───┘└──────┘└──┘ └───────┘
    /app /invoices [id]  "this folder is a page"
```

And the routing is **inferred at build time, not per request.** You never declare
routes in code — Next scans the `app/` tree during the build and generates the route
map; at request time it's just a lookup. Contrast a manual router:

```
Express (manual):   app.get("/invoices/:id", handler)   ← you declare routes in code
Next (file-based):  app/invoices/[id]/page.tsx           ← the directory tree IS the route config
```

1. **The reserved filenames carry the meaning** (filename = role, folder = segment):

   | File in a folder | Meaning |
   |---|---|
   | `page.tsx` | the page rendered at this path |
   | `layout.tsx` | a shell wrapping this folder + everything under it ([§3](#3-applayouttsx-the-shell-that-wraps-every-page)) |
   | `loading.tsx` | shown while the page loads |
   | `error.tsx` | shown if the page throws |
   | `route.ts` | an API endpoint instead of a page |

2. **`[id]` (brackets) = a *dynamic* segment** — the folder matches any value and
   captures it as a param (`useParams().id`, [§23](#23-the-invoice-detail--review-page)). One file
   (`invoices/[id]/page.tsx`) serves `/app/invoices/abc`, `/app/invoices/xyz`, etc.
3. **`(group)` (parens) = organizational, not part of the URL** — a folder named
   `(marketing)` groups files without adding a path segment. (trueline doesn't use
   these, but they appear in larger apps.)
4. **`app/layout.tsx`** is the root shell — same convention, the `layout.tsx`
   reserved name ([§3](#3-applayouttsx-the-shell-that-wraps-every-page)). It renders once and persists across navigation.
5. Two non-page files matter too: **`middleware.ts`** (repo root) runs before any
   route ([§2](#2-middlewarets-runs-before-every-request)), and **`app/providers.tsx`** sets up Clerk + Convex ([§4](#4-appproviderstsx-the-client-boundary--live-connections)).

> **Summary:** the directory tree *is* the route configuration — folders are
> URL segments, `page.tsx` makes a segment renderable, brackets make it dynamic, and
> Next compiles all of that into the router at build time so you never write route
> declarations yourself.

---

## 2. `middleware.ts` runs before every request

**File:** [`middleware.ts`](../middleware.ts)

The **first code that executes** for any request — before any page renders. Next
runs it at the edge on every request matching its `config.matcher`.

```ts
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)"],
};
```

1. **`clerkMiddleware(...)`** wraps the app; on every request it reads the Clerk
   session cookie and resolves whether you're signed in. That's what makes
   `<SignedIn>` / `<SignedOut>` work downstream without each page re-checking.
2. **`isProtected = createRouteMatcher(["/app(.*)"])`** matches `/app` and anything
   beneath it (`(.*)` = "and any suffix"). The landing `/` is deliberately *not*
   listed.
3. **`if (isProtected(req)) await auth.protect();`** is the gate: for a `/app/...`
   URL with no session, redirect to sign-in; for `/`, do nothing.
4. **`config.matcher`** is an optimization — skip the middleware entirely for Next
   internals (`_next`) and static files (`.*\\..*`), so it only fires on real
   navigations and API routes.

> **Summary:** middleware = the bouncer at the door. Public pages pass;
> anything under `/app` must show a valid session or get bounced. Runs *before*
> React renders anything.

---

## 3. `app/layout.tsx`, the shell that wraps every page

**File:** [`app/layout.tsx`](../app/layout.tsx)

Every page renders *inside* the root layout.

```tsx
export const metadata: Metadata = { title: "trueline …", description: "…" };

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
```

1. **The only place `<html>`/`<body>` exist.** The layout owns the document; each
   page is slotted in as `{children}`. It renders *once* and stays mounted while you
   navigate — pages swap in/out of `{children}`, but anything the layout sets up
   (notably the Convex socket, via `Providers`) persists.
2. **`<Providers>{children}</Providers>`** — every page is always nested
   `html > body > Providers > [page]`.
3. **`THEME_BOOTSTRAP` `<script>`** runs *synchronously before paint*. It reads
   `localStorage["theme"]` and toggles a `light` class on `<html>` so you never see
   a flash of the wrong theme before React loads.
4. **`suppressHydrationWarning`** on `<html>` — because that script *mutates*
   `<html>` (adds `light`) before React hydrates, the server HTML and the browser
   DOM differ on that one attribute. This tells React "that mismatch is intentional."
5. **`export const metadata`** is how the App Router sets `<title>`/`<meta>`.

> **Summary:** the layout is the picture frame; pages are pictures swapped
> into it. It renders on the server, owns the document, and persists across
> navigation.

---

## Concept — Hydration, and the hydration mismatch

**Hydration** is the step where, after the browser downloads the React JS bundle,
React runs your components *again in the browser* and attaches itself to the
server-rendered HTML — wiring up event handlers, state, and effects — so the static
markup becomes a live, interactive app.

```
Server:  render → HTML string → sent to browser → user SEES it (not interactive)
Browser: download JS → run components again → "hydrate" → attach handlers → INTERACTIVE
```

React assumes the server HTML and the browser's first render are **identical** — it
just attaches behavior, it doesn't rebuild. A **hydration mismatch** is when they
differ; React can't safely attach and warns (and may discard the server HTML for
that subtree).

Why it appears here: the server renders `<html>` with no `light` class (servers have
no `localStorage`), then `THEME_BOOTSTRAP` *mutates* it to `<html class="light">`
before React hydrates → React sees a difference → we silence that one element with
`suppressHydrationWarning`. It's a deliberate, scoped suppression, not a blanket one.

> **In brief:** hydration = the browser bringing the server's static HTML to
> life; a hydration error = the live version didn't match the static one, usually
> because something changed before React got there.

---

## 4. `app/providers.tsx`, the client boundary + live connections

**File:** [`app/providers.tsx`](../app/providers.tsx)

Where the app stops being server-only HTML and gains its live brain.

```tsx
"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL || "https://placeholder.convex.cloud",
);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
```

1. **`"use client"` is the boundary.** Everything from here down ships JS and becomes
   interactive. The layout above stays server-only; `Providers` is the deliberate
   single crossing into "interactive browser land."
2. **`const convex = new ConvexReactClient(...)` is at *module scope*** (see the next
   concept box). Created **once per tab**, it opens **one WebSocket** to Convex and
   holds it open for the tab's life. That socket is what makes every `useQuery` live.
   It lives inside the layout's persistent tree, so it survives page navigation.
3. **`process.env.NEXT_PUBLIC_CONVEX_URL`** — the `NEXT_PUBLIC_` prefix tells Next to
   inline the value into the browser bundle (the browser needs it to connect). LLM
   keys have *no* such prefix → they stay server-side and never reach the browser.
4. **The nesting is the auth handshake:** `ClerkProvider` manages identity;
   `ConvexProviderWithClerk` is the bridge — `useAuth={useAuth}` hands Clerk's hook
   to Convex so it can grab a fresh Clerk JWT and attach it to every request;
   `{children}` (your pages) render inside both, so any page's `useQuery` is
   automatically authenticated.

> **Summary:** Providers is where the app plugs in — one persistent socket to
> the DB (Convex), one identity provider (Clerk), wired so every data call carries
> your identity automatically.

---

## Concept — Module scope vs component scope

**Scope** = where code lives, which decides *when* it runs.

- **Module scope** = the top level of the file, *not inside any function*. Runs
  **once**, the first time the file is imported; the value is shared by everyone who
  imports the file. → the file's one-time setup.
- **Component scope** = inside the component function's body (between its `{` and
  `}`). Runs on **every render** — possibly hundreds of times. → the component's
  repeated work.

```tsx
const convex = new ConvexReactClient(...);   // MODULE scope → runs ONCE → one socket ✅

export function Providers({ children }) {     // the COMPONENT function
  // anything here = COMPONENT scope → runs EVERY render
  return ( ... );
}
```

If `new ConvexReactClient(...)` were *inside* the component, it would build a new
client (new WebSocket) on every render — a reconnect storm that drops every live
subscription. Putting it at module scope makes it a **singleton**: one stable
connection. The test: *"once, or every render?"* Once → module scope.

> **In brief:** module scope = the file's setup that runs once; component scope =
> the function's work that runs every render. Long-lived things (a DB connection)
> belong at module scope.

---

## Concept — Server Components vs Client Components

The App Router's central distinction is **where a component's code executes** — on the server, in the browser, or both.

Every component is a **Server Component by default**; it becomes a **Client
Component** only if its file starts with `"use client"`.

**Server Component** (no directive — e.g. `app/page.tsx`, `app/layout.tsx`):
- Code runs **on the server**, produces HTML; its JS is **never shipped** to the
  browser.
- Cannot use `useState`/`useEffect`/`onClick` (no interactivity).
- Can be `async` and read data/secrets directly. Cheap (less JS for the user).

**Client Component** (`"use client"` — e.g. everything under `app/app/`,
`providers.tsx`, `nav.tsx`):
- Renders to HTML on the server for the first paint **and** ships JS to the browser,
  where it **hydrates** and becomes interactive.
- Can use hooks, event handlers, `useQuery`/`useMutation`.

The boundary is **one-directional**: once a file says `"use client"`, everything it
imports joins the client bundle. That's exactly why `providers.tsx` is the boundary —
the layout stays a cheap server component, and `Providers` is the single point where
we cross into interactivity.

```
app/layout.tsx          ← Server Component (no JS shipped)
  └─ app/providers.tsx     ← "use client" ← THE BOUNDARY
       └─ your pages        ← Client Components (hooks, live data, clicks)
```

> **In brief:** Server Component = compute once on the server, send dead HTML,
> ship no JS. Client Component = send HTML *and* JS, then bring it to life in the
> browser. Default to server; opt into client only where you need interactivity.

---

## 5. `app/page.tsx`, the landing page (a Server Component)

**File:** [`app/page.tsx`](../app/page.tsx)

The page at `/`. No `"use client"` → all of this runs on the server and ships as HTML.

```tsx
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";

const PIPELINE = [
  ["Upload", "Invoice text → Convex storage + a record (mutation)."],
  ["Extract", "An action calls the LLM with a strict JSON schema… The model only reads."],
  ["Verify", "Deterministic code recomputes qty × unit price. The LLM never does math."],
  // …Reconcile, Flag, Review, Eval
];
const STACK = [
  ["Next.js 16 + React 19", "App Router, server components for the shell…"],
  ["Convex", "The backend: reactive queries, transactional mutations, and an action…"],
  // …Clerk, LLM, Tailwind
];
```

1. **`PIPELINE` and `STACK` are just text content** — plain arrays of
   `[title, description]` pairs holding the homepage's marketing copy. The component
   `.map()`s over them to draw the "verification pipeline" numbered list and the
   "stack" card grid. They *describe* the app; they are not the logic (which lives in
   `convex/`). Stored as arrays so the page renders them in a loop instead of
   copy-pasting markup.
2. **`<SignedIn>` / `<SignedOut>`** (Clerk) render their children based on session.
   Signed out → a `<SignInButton mode="modal">`; signed in → an "Open workspace"
   `<Link>` + `<UserButton>` avatar. This works in a *server* component because the
   middleware already resolved the session.
3. **`<Link href="/app">`** is client-side navigation — no full reload; Next fetches
   just the new route and keeps the layout (and its socket) alive.
4. The footer + sign-in note carry the honest disclaimer that the **sample data is
   synthetic and fictional, and you can also run it on your own real contract and invoices**.

> **Summary:** the landing is a static brochure rendered entirely on the
> server — describing the pipeline and stack, with exactly one interactive control
> (sign in / open workspace), chosen by the session the middleware already resolved.

---

# Part 2 — Identity

## 6. Clicking "Sign in": the Clerk flow

**File:** [`app/page.tsx`](../app/page.tsx) (the `SignInButton`); the sign-in UI itself is Clerk-hosted

```tsx
<SignInButton mode="modal">
  <button>Sign in</button>
</SignInButton>
```

1. **`mode="modal"`** opens Clerk's sign-in overlay on top of the page (no separate
   URL). The whole UI is Clerk's — trueline writes none of it.
2. **Clerk authenticates on its servers** and sets a **session cookie** — the same
   cookie the middleware reads on every future request.
3. **The UI flips reactively:** the moment a session exists, `<SignedIn>`/
   `<SignedOut>` re-evaluate and the header swaps "Sign in" → "Open workspace" +
   avatar. No reload.
4. **Two identities now exist** — the subtle, important part:
   - the **session cookie** → proves to *Next/middleware* you're logged in (gates
     `/app`);
   - a **Convex JWT** → a separate token Clerk mints on demand from the "convex"
     template, which *Convex* verifies. (`ConvexProviderWithClerk` was wired in
     [§4](#4-appproviderstsx-the-client-boundary--live-connections) precisely to fetch and attach it.)
5. **Click "Open workspace"** → `<Link href="/app">` → the protected matcher applies,
   sees the valid session, lets you through.

> **Summary:** signing in mints your identity in two forms — a cookie for
> Next/middleware (gets you past the door) and a JWT for Convex (authenticates and
> tenant-scopes your data requests).

---

## Concept — How a JWT works

**JWT (JSON Web Token)** is a small, self-contained string proving "this request is
from an authenticated user with these properties," verifiable **without calling back
to the login server**.

Physically, three Base64 chunks joined by dots: `header.payload.signature`.

1. **Header** — algorithm + type.
2. **Payload (claims)** — the data, e.g.:
   ```json
   { "sub": "user_abc123", "org_id": "org_xyz789",
     "iss": "https://your-slug.clerk.accounts.dev", "exp": 1718600000 }
   ```
   > Not encrypted — anyone can decode and read it. The JWT provides **integrity**
   > ("untampered"), not secrecy. So: user id + org id are fine; passwords never.
3. **Signature** — a cryptographic stamp over header+payload, made with a key only
   the issuer (**Clerk**) holds.

**Why it's trustworthy:** Clerk signs with a private key; Convex verifies against
Clerk's public key. Change one character of the payload (e.g. swap `org_id` to read
another tenant) and the signature no longer matches → rejected. So Convex trusts the
claims **without a per-request callback** — fast and stateless.

In trueline: sign in → Clerk mints+signs a JWT (with `sub`, `org_id`, `iss`, `exp`)
→ `ConvexProviderWithClerk` attaches it to every call → Convex checks the signature
(it knows which issuer to trust via `auth.config.ts`) → `ctx.auth.getUserIdentity()`
hands the verified claims to the function, which reads `org_id` to scope the query.
`exp` keeps tokens short-lived; Clerk silently mints fresh ones.

> **In brief:** a JWT is a signed, self-verifying ID card; Clerk issues+signs it,
> Convex checks the signature and reads `org_id` from it — no per-request callback.

---

## 7. `auth.config.ts`: how Convex decides to trust the JWT

**File:** [`convex/auth.config.ts`](../convex/auth.config.ts)

```ts
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,  // your Clerk Frontend API URL
      applicationID: "convex",                       // the JWT template name
    },
  ],
};
```

1. This is Convex's statement: *"I trust JWTs whose `iss` is this Clerk domain and
   whose audience is `convex`."* It's the public-key/issuer trust anchor from the JWT
   concept box.
2. **`applicationID: "convex"`** matches Clerk's one-click "Convex" JWT template — so
   only tokens minted from that template are accepted.
3. `CLERK_JWT_ISSUER_DOMAIN` lives on the **Convex** deployment (server-side), set via
   `npx convex env set` — see `DEPLOYMENT.md`.

> **Summary:** `auth.config.ts` is the one-line bridge that tells Convex
> whose signatures to trust. Without it, every authenticated call would be rejected.

---

# Part 3 — Landing in the workspace + the data model

## 8. `/app` mounts and fires live queries

**File:** [`app/app/page.tsx`](../app/app/page.tsx) (top of `Dashboard`)

`app/app/page.tsx` (a Client Component). After hydration, the top of `Dashboard`:

```tsx
export default function Dashboard() {
  const { isAuthenticated } = useConvexAuth();
  const baseline   = useQuery(api.invoices.baseline);
  const invoices   = useQuery(api.invoices.listInvoices);
  const stats      = useQuery(api.invoices.stats);
  const routingCfg = useQuery(api.routing.get);
  const createInvoice = useMutation(api.invoices.createInvoiceFromText);
  // …more mutations
  const [msg, setMsg] = useState<string | null>(null);

  if (!isAuthenticated || baseline === undefined || invoices === undefined) {
    return ( <main><Nav/><p>connecting your account…</p></main> );
  }
```

1. **`useConvexAuth()`** reports whether *Convex* has accepted the Clerk JWT yet —
   distinct from Clerk's own "signed in." There's a brief window where Clerk says
   "signed in" but Convex hasn't verified the JWT over the socket, so this can be
   `false` for a render or two.
2. **Each `useQuery(api.xxx)` opens a live subscription** over the §4 socket:
   Convex runs the query, returns the result, and **re-sends automatically whenever
   the underlying data changes**. You never call "refresh."
3. **`useMutation(api.xxx)` returns a *function*** — armed but idle until you invoke
   it (e.g. on upload). Queries read-and-subscribe immediately; mutations wait.
4. **`api.invoices.baseline` is auto-generated.** Writing a function in
   `convex/invoices.ts` produces a typed reference at `api.invoices.<name>`
   (`@/convex/_generated/api`), so frontend↔backend calls are fully type-checked.
5. **The loading guard:** a `useQuery` returns `undefined` while loading. So until
   Convex auths *and* the first queries resolve, show "connecting…" instead of a
   half-built UI — this hides the JWT-propagation gap from #1.

> **Summary:** mounting the dashboard opens several live subscriptions at
> once. `useQuery` = "read and keep me updated forever"; `useMutation` = "give me a
> function to change data later."

---

## Concept — Convex query / mutation / action

Three backend function types, each with a strict contract. This split *is* the
architecture.

| Type | Reactive? | Transactional? | Network I/O? | `ctx.db`? | Used for |
|---|:--:|:--:|:--:|:--:|---|
| **query** | ✅ (live) | ✅ | ❌ | read | reads the UI subscribes to |
| **mutation** | — | ✅ | ❌ | read+write | atomic writes |
| **action** | — | ❌ | ✅ | ❌ | external calls (the LLM) |

- **query** — read-only, runs reactively, pushes updates over the socket.
  (`listInvoices`, `getInvoice`, `stats`, `baseline`, `routing.get`, `recentLogs`,
  `evals.listEvals`.)
- **mutation** — a single atomic transaction; can't do network calls.
  (`createInvoiceFromText`, `submitExtraction`, `reviewLine`, `correctLine`,
  `seedIfEmpty`, `setBaselineFromText`, `routing.set`, `evals.runEval`.)
- **action** — the *only* place `fetch` is allowed; **not** transactional, **not**
  auto-retried, has no `ctx.db`. Reads/writes by calling queries/mutations.
  (`extract.run`, `diagnostics.benchmark`.)

> **The architectural rule:** the external, fallible, non-transactional step (the
> LLM read) is quarantined in an **action**; every decision touching money is a pure
> function called inside a transactional **mutation**.

---

## 9. The backend reads: `optionalOrg`, `requireOrg`, multi-tenancy

**File:** [`convex/invoices.ts`](../convex/invoices.ts)

How a query authenticates and isolates tenants (`convex/invoices.ts`):

```ts
async function requireOrg(ctx) {                 // for WRITES — throws if no auth
  const id = await ctx.auth.getUserIdentity();
  if (!id) throw new Error("Not authenticated");
  const orgId = id.org_id ?? `user:${id.subject}`;
  return { orgId, who: id.email ?? id.name ?? id.subject };
}

async function optionalOrg(ctx): Promise<string | null> {  // for READS — never throws
  const id = await ctx.auth.getUserIdentity();
  if (!id) return null;
  return id.org_id ?? `user:${id.subject}`;
}

export const listInvoices = query({
  args: {},
  handler: async (ctx) => {
    const orgId = await optionalOrg(ctx);
    if (!orgId) return [];
    const invoices = await ctx.db.query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))   // tenant filter
      .order("desc").collect();
    // …attach per-invoice red/yellow/green counts
  },
});
```

1. **`ctx.auth.getUserIdentity()`** returns the *verified* JWT claims (the signature
   was checked using `auth.config.ts`). No DB lookup needed — the JWT concept box
   explains why that's safe.
2. **Tenant = `org_id` claim, else `user:<subject>`.** A reviewer who hasn't made a
   Clerk org still gets an isolated, seeded space keyed to their user id.
3. **`requireOrg` throws; `optionalOrg` returns null.** This is the deliberate pair:
   *writes* must have auth (throw if not); *reads* must degrade to an empty state,
   because Convex auth can lag a render behind Clerk and a thrown read would
   white-screen the client.
4. **`.withIndex("by_org", q => q.eq("orgId", orgId))`** filters every query through
   the tenant index — so one tenant **physically cannot** read another's rows. The
   isolation is enforced at the index, not in ad-hoc app logic.

> **Summary:** every read scopes to your `orgId` via an index; reads fail
> soft (empty), writes fail loud (throw). Multi-tenancy is a `withIndex` invariant,
> not a convention.

---

## 10. Seeding an empty account (`seedIfEmpty`)

**Files:** [`convex/invoices.ts`](../convex/invoices.ts) (`seedIfEmpty`) · [`convex/lib/demoData.ts`](../convex/lib/demoData.ts)

First sign-in has no data. The dashboard offers "skip the walkthrough and load
everything," which calls:

```ts
export const seedIfEmpty = mutation({
  args: {},
  handler: async (ctx) => {
    const { orgId } = await requireOrg(ctx);
    const existing = await ctx.db.query("invoices")
      .withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (existing) return { seeded: false };               // idempotent

    await ctx.db.insert("purchaseOrders", { orgId, poNumber: DEMO_PO_NUMBER, … });
    for (const c of DEMO_CATALOG) await ctx.db.insert("catalog", { orgId, ...c });
    for (const inv of DEMO_INVOICES) {
      const invoiceId = await ctx.db.insert("invoices", { orgId, status: "needs_review", … });
      const rollup = await insertReconciledLines(ctx, { orgId, invoiceId, extracted: parsePipeInvoice(inv.rawText) });
      await ctx.db.patch(invoiceId, rollup);
    }
    return { seeded: true };
  },
});
```

1. **Idempotent** — returns early if any invoice already exists (`:179`), so a
   double-click or remount can't duplicate the demo.
2. Inserts the demo **PO** (`DEMO_PO_LINES`), the **catalog** (`DEMO_CATALOG`), and
   three **invoices** from `convex/lib/demoData.ts` — one clean (`INV-1009`), one
   padded (`INV-1010`), one with errors (`INV-1011`).
3. **Reconciles each invoice at seed time** via `insertReconciledLines` ([§20](#20-reconcile--write-writeresults--insertreconciledlines)),
   so flags + recoverable totals exist the instant the dashboard loads.
4. All of this is **one transaction** (it's a mutation) — the seeded world is
   all-or-nothing.

> **Summary:** seeding builds a believable demo tenant atomically, reusing
> the exact same reconcile path a real upload uses — so the seeded data and live
> uploads are computed identically.

---

## 11. The data model (`schema.ts`) — the read/decide split, in tables

**File:** [`convex/schema.ts`](../convex/schema.ts)

`convex/schema.ts` defines the tables. Two hold the **baselines** an invoice is judged
against; the interesting one is `invoiceLines`.

```ts
purchaseOrders: { orgId, poNumber, vendor, lines: [{ sku, description, unit, quantity, unitPrice }] }
catalog:        { orgId, sku, description, unit, marketPrice, category? }   // market "should cost"

invoiceLines: defineTable({
  orgId, invoiceId, lineNo,
  // ---- what the LLM read (it only reads; it never decides) ----
  description, sku?, unit, quantity, unitPrice,
  claimedExtension,     // the number printed on the invoice
  confidence,           // 0..1, per-line, from the model
  sourceQuote,          // verbatim snippet the numbers came from
  // ---- what deterministic code verified/decided ----
  computedExtension,    // qty * unitPrice, recomputed in code
  mathOk, poUnitPrice?, catalogPrice?, matchedBy?,
  varianceVsPoPct?, varianceVsMarketPct?,
  flag,                 // "green" | "yellow" | "red"
  reasons,              // human-readable
  recoverableUsd,
  // ---- human-in-the-loop ----
  decision,             // pending | approved | edited | rejected
  reviewer?,
}).index("by_invoice", ["invoiceId"]).index("by_org_decision", ["orgId", "decision"])
```

1. **The schema physically encodes the thesis.** `invoiceLines` columns are split by
   comment into "what the LLM read" vs "what code decided." A reviewer (or auditor)
   can see exactly which fields a model touched and which are deterministic.
2. **`sourceQuote`** grounds every extracted number to a verbatim snippet, so any
   field traces back to the document.
3. **Every table carries `orgId` and a `by_org*` index** — the substrate for §9's tenant isolation.
4. Other tables: **`invoices`** (the header + rollups: `recoverableUsd`,
   `extractionProvider`, `latencyMs`, `costUsd`, `status`), **`logs`** (Diagnostics
   event log), **`settings`** (per-tenant routing mode/model), **`evalRuns`** (scored
   precision/recall history).

> **Summary:** the table layout *is* the trust boundary — model-read fields
> and code-decided fields are separated on disk, not just in prose.

---

# Part 4 — The core codepath: upload → verdict

## 12. The guided stepper UI

**File:** [`app/app/page.tsx`](../app/app/page.tsx) (`Stepper`)

The dashboard is a 4-step wizard (`app/app/page.tsx`):

```tsx
const hasPo = baseline.hasPo;
const nInv  = invoices.length;
const step  = !hasPo ? (nInv === 0 ? 1 : 4) : nInv === 0 ? 3 : 4;
```

1. **`step` is derived, not stored** — computed from "is there a PO?" and "how many
   invoices?" So the UI always reflects the real data state: no baseline + no
   invoices → step 1 (download/upload contract); baseline but no invoices → step 3
   (upload an invoice); otherwise → step 4 (review).
2. The `<Stepper>` component (`:107`) renders the four pills (Download → Upload
   contract → Upload invoice → Review) with done/now/todo styling.
3. Step 1 also offers **"skip the walkthrough and load everything"** → `seedIfEmpty`
   ([§10](#10-seeding-an-empty-account-seedifempty)). Step 2 uploads a contract → `setBaselineFromText` (parses pipe text
   into PO lines, makes it the baseline, seeds the catalog if absent).

> **Summary:** the wizard step is a pure function of the data — there's no
> separate "where am I" state to get out of sync.

---

## 13. Uploading a file (the browser side)

**File:** [`app/app/page.tsx`](../app/app/page.tsx) (`UploadButton`)

```tsx
function UploadButton({ label, onText, primary, multiple }) {
  return (
    <label className="…cursor-pointer…">
      {label}
      <input type="file" multiple={multiple} accept=".txt,.csv,text/plain" className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          for (const f of files) onText(await f.text(), f.name);  // read in the browser
          e.target.value = "";
        }} />
    </label>
  );
}
```

1. **A styled `<label>` wrapping a hidden `<input type="file">`** — the standard way
   to get a custom-looking file picker. Clicking the label opens the OS file dialog.
2. **`await f.text()`** reads the file's contents in the browser (the File API). For
   each selected file it calls `onText(text, filename)` → `uploadInvoice`.
3. **`e.target.value = ""`** resets the input so picking the *same* file again still
   fires `onChange`.

> **Summary:** the file never goes to a server as a file — its text is read
> in the browser and handed to a handler. (For this demo the "documents" are pipe-
> delimited text; a production version would add PDF/image OCR upstream.)

---

## 14. `uploadInvoice` decides which route extraction takes

**File:** [`app/app/page.tsx`](../app/app/page.tsx) (`uploadInvoice`)

```tsx
async function uploadInvoice(text: string, filename: string) {
  const m = (filename + " " + text).match(/INV-\d+/);
  const invoiceNumber = m?.[0] ?? filename.replace(/\.\w+$/, "");
  const mode = routingCfg?.mode ?? "auto";
  const tryLocal = mode === "auto" || mode === "local";

  const invoiceId = await createInvoice({ invoiceNumber, rawText: text, deferServer: tryLocal });

  if (!tryLocal) { setMsg("✓ Uploaded — extracting on the server…"); return; }
  // …Branch A (browser→host Ollama) below
}
```

1. **Derives `invoiceNumber`** by regex-matching `INV-\d+` from the filename/text,
   else the filename stem.
2. **Reads the tenant routing `mode`** from the cached `routingCfg` query. `tryLocal`
   is true only for `auto`/`local` (modes that could use a model on the user's
   machine).
3. **Calls `createInvoice({ …, deferServer: tryLocal })`.** The `deferServer` flag is
   the fork: if true, the browser will try local Ollama first; if false, the server
   action handles everything.

> **Summary:** the client decides *who reads the document* — your own machine
> (private, free) or the cloud — based on the routing mode, and signals that to the
> backend with `deferServer`.

---

## 15. `createInvoiceFromText` mutation (one transaction)

**File:** [`convex/invoices.ts`](../convex/invoices.ts) (`createInvoiceFromText`)

```ts
export const createInvoiceFromText = mutation({
  args: { invoiceNumber: v.string(), rawText: v.string(), poNumber: v.optional(v.string()),
          deferServer: v.optional(v.boolean()) },
  handler: async (ctx, { invoiceNumber, rawText, poNumber, deferServer }) => {
    const { orgId, who } = await requireOrg(ctx);
    const invoiceId = await ctx.db.insert("invoices", {
      orgId, invoiceNumber, vendor: DEMO_VENDOR, poNumber: poNumber ?? DEMO_PO_NUMBER,
      rawText, status: "extracting", uploadedBy: who,
    });
    await ctx.db.insert("logs", { orgId, level: "info", event: "upload", detail: `${invoiceNumber} uploaded…` });
    if (!deferServer) {
      await ctx.scheduler.runAfter(0, internal.extract.run, { invoiceId, orgId });  // schedule the action
    }
    return invoiceId;
  },
});
```

1. **A mutation = one atomic transaction.** The invoice row + the log row commit
   together or not at all.
2. **Inserts the invoice as `status: "extracting"`** and stamps `uploadedBy: who`.
3. **The fork:** if `deferServer` is false, schedule the server action with
   `ctx.scheduler.runAfter(0, internal.extract.run, …)` — "run this action as soon as
   possible, after this transaction commits." If `deferServer` is true, it does **not**
   schedule — extraction is left to the browser (Branch A).
4. **The instant this commits, the open `listInvoices`/`getInvoice` subscriptions
   push** the new "extracting" row to every client of this tenant. The UI updates
   with zero polling.

> **Summary:** the upload first records an "extracting" invoice atomically,
> then either hands off to the browser (defer) or schedules the cloud action — and
> the live queries reflect it immediately.

---

## 16. Branch A: browser→host Ollama

**Files:** [`app/app/page.tsx`](../app/app/page.tsx) (`uploadInvoice`) · [`app/lib/ollama.ts`](../app/lib/ollama.ts)

The most distinctive mechanism in the app. Continuing `uploadInvoice` (`tryLocal` was true):

```tsx
try {
  const base = await probeOllama();              // localhost:11434, then :11435 proxy
  if (base) {
    const model = routingCfg?.model || routingCfg?.defaultLocalModel || "llama3.1:8b";
    const lines = await extractWithOllama(text, model, base);   // model runs on YOUR machine
    if (lines.length) {
      await submitExtraction({ invoiceId, provider: "ollama (browser→host)", model, latencyMs, lines });
      return;
    }
  }
} catch { /* unreachable / CORS / parse failure → fall through */ }
await scheduleExtract({ invoiceId });            // fallback: hand to the server action
```

1. **Why this exists:** the Convex extract action runs in Convex's cloud and *cannot*
   reach a reviewer's `localhost:11434`. But the reviewer's **browser** can. So the
   browser does the model read locally and posts structured lines to the cloud.
2. **`probeOllama()`** (`app/lib/ollama.ts`) tries `localhost:11434`, then a `:11435`
   CORS-proxy, each with a 1.5s timeout, result cached 30s. Returns a reachable base
   URL or `null`.
3. **`extractWithOllama`** POSTs to `/api/chat` with `format: "json"` and the
   read-only system prompt; `parseLines` strips ``` fences and coerces fields.
4. **`submitExtraction`** (a mutation) reconciles + writes the browser-extracted lines
   ([§20](#20-reconcile--write-writeresults--insertreconciledlines)). On any failure (unreachable / CORS / no lines), it falls through to
   **`scheduleExtract`**, which schedules the server action — so extraction always
   happens somewhere.

> **Summary:** "the cloud can't reach your laptop, but your browser can" — so
> a cloud-hosted demo runs a real model *for free* on the reviewer's machine, and the
> server still does all the deterministic reconcile.

---

## 17. Branch B: the server action (`extract.run`)

**File:** [`convex/extract.ts`](../convex/extract.ts)

When extraction runs server-side, the scheduler invokes `extract.run` — an
`internalAction`.

```ts
export const run = internalAction({
  args: { invoiceId: v.id("invoices"), orgId: v.string() },
  handler: async (ctx, { invoiceId, orgId }) => {
    try {
      const inv = await ctx.runQuery(internal.extract._getRaw, { invoiceId });  // action has no ctx.db
      if (!inv) return;
      const routing = await ctx.runQuery(internal.routing._forExtract, { orgId });
      const t0 = Date.now();
      const { lines, provider, model } = await extractLineItems(inv.rawText, routing);  // the LLM (network!)
      const latencyMs = Date.now() - t0;
      const costUsd = provider === "anthropic" ? /* token estimate */ : 0;
      await ctx.runMutation(internal.invoices.writeResults, { invoiceId, orgId, lines, provider, model, latencyMs, costUsd });
      await ctx.runMutation(internal.invoices.appendLog, { … });
    } catch (err) {
      await ctx.runMutation(internal.invoices.markError, { invoiceId, error: String(err).slice(0, 300) });
      await ctx.runMutation(internal.invoices.appendLog, { …level: "error"… });
    }
  },
});
```

1. **An action is the only place network I/O is allowed**, but it's **not
   transactional and not auto-retried**, and has **no `ctx.db`**.
2. **It reads through a query** (`_getRaw`) and the routing config, because it can't
   touch the DB directly — each of those is its own transaction.
3. **It batches *all* DB writes into one mutation** (`writeResults`), keeping the
   fallible external step separate from the atomic write.
4. **Idempotency despite no retries:** the work is keyed on the invoice `_id`, and
   `writeResults` → `insertReconciledLines` **clears any existing lines before
   re-inserting** ([§20](#20-reconcile--write-writeresults--insertreconciledlines)). So a manual re-run can't double-insert.
5. **On any throw → `markError`** flips the invoice to `needs_review` with an error
   string + an error log row.

> **Summary:** the action is a careful airlock — do the risky network call
> outside any transaction, then commit the result in a single idempotent mutation,
> and record failures instead of crashing.

---

## 18. Provider routing (`llm.ts` → `extractLineItems`)

**File:** [`convex/lib/llm.ts`](../convex/lib/llm.ts) (`extractLineItems`)

```ts
export async function extractLineItems(rawText, routing = {}) {
  const mode = routing.mode ?? "auto";
  const { free, paid } = keyStatus();                       // which keys exist
  const localUp = (mode === "auto" || mode === "local") ? await ollamaReachable() : false;

  const order =
    mode === "offline" ? []
    : mode === "local"  ? (localUp ? ["ollama"] : [])
    : mode === "free"   ? ["openrouter"]
    : mode === "paid"   ? ["anthropic"]
    : localUp ? ["ollama", "anthropic", "openrouter"] : ["anthropic", "openrouter"];  // auto

  for (const provider of order) {
    try {
      if (provider === "ollama")              { const l = await callOllama(...);     if (l.length) return {lines:l, provider, model}; }
      if (provider === "anthropic" && paid)   { const l = await callAnthropic(...);  if (l.length) return {lines:l, provider, model}; }
      if (provider === "openrouter" && free)  { const l = await callOpenRouter(...); if (l.length) return {lines:l, provider, model}; }
    } catch { /* try the next provider, then offline */ }
  }
  return { lines: parsePipeInvoice(rawText), provider: "mock", model: "deterministic" };  // ALWAYS completes
}
```

1. **The mode builds an explicit, ordered list of providers to try.** `auto` =
   local-first (if the cached probe says Ollama is up) → paid → free.
2. **Each provider sends the same read-only `SYSTEM` prompt** ("ONLY read values that
   appear — never invent or compute"). The first provider returning ≥1 line wins.
3. **`keyStatus()`** gates paid/free on whether `ANTHROPIC_API_KEY` /
   `OPENROUTER_API_KEY` are set on the Convex deployment.
4. **The terminal fallback is deterministic** (`parsePipeInvoice`, provider `"mock"`)
   — so the pipeline **always** completes, even with zero keys and zero network. This
   is why every demo "works on real data" without an API key.

> **Summary:** routing is a try-list, not a switch — each mode is a sequence
> of attempts with a deterministic safety net at the end. Quality degrades
> gracefully; the pipeline never fails to produce lines.

---

## 19. Parsing messy model output (`parse.ts`, coerce, loose JSON)

**Files:** [`convex/lib/llm.ts`](../convex/lib/llm.ts) · [`convex/lib/parse.ts`](../convex/lib/parse.ts)

Models return imperfect JSON. Two layers defang it (`convex/lib/llm.ts` +
`convex/lib/parse.ts`):

```ts
function parseJsonLoose(text) {                 // tolerate ``` fences + prose around JSON
  const fenced = text.includes("```") ? text.split("```")[1]?.replace(/^json/i, "") : text;
  const s = (fenced ?? text).trim();
  const start = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter(i => i >= 0));
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function coerceLines(raw) {                      // force every field into the right type
  // accepts {lines:[…]} or a bare array; num() strips $ and commas;
  // handles unitPrice|unit_price, clamps confidence to 0..1, drops empty descriptions
}
```

1. **`parseJsonLoose`** strips Markdown ``` fences and slices from the first `{`/`[`
   to the last `}`/`]` — so leading/trailing prose doesn't break parsing.
2. **`coerceLines`** normalizes each line: numbers stripped of `$`/`,`, snake_case vs
   camelCase aliases, confidence clamped to `[0,1]`, blank-description lines dropped.
3. **`parsePipeInvoice` / `parsePoText`** (`parse.ts`) are the deterministic parsers
   for the pipe format (`SKU | Desc | Qty | Unit | Price | Extension`). The same
   `parsePipeInvoice` is reused as the zero-key fallback in [§18](#18-provider-routing-llmts--extractlineitems) *and* by the seed
   in [§10](#10-seeding-an-empty-account-seedifempty) — one parser, three callers.

> **Summary:** never trust the model's formatting — slice to the JSON, coerce
> every field, and keep a deterministic parser that handles the exact same shape.

---

## 20. Reconcile + write (`writeResults` → `insertReconciledLines`)

**File:** [`convex/invoices.ts`](../convex/invoices.ts) (`insertReconciledLines`, `writeResults`, `submitExtraction`)

Both the server path (`writeResults`) and the browser path (`submitExtraction`)
funnel into one shared function:

```ts
async function insertReconciledLines(ctx, { orgId, invoiceId, extracted }) {
  const poLines = (await ctx.db.query("purchaseOrders").withIndex("by_org", q => q.eq("orgId", orgId)).collect())
                    .flatMap(p => p.lines);
  const catalog = await ctx.db.query("catalog").withIndex("by_org", q => q.eq("orgId", orgId)).collect();

  // idempotent: clear any prior lines for this invoice before re-inserting
  for (const l of await ctx.db.query("invoiceLines").withIndex("by_invoice", q => q.eq("invoiceId", invoiceId)).collect())
    await ctx.db.delete(l._id);

  let recoverableUsd = 0, claimedTotal = 0, lineNo = 0;
  for (const line of extracted) {
    const r = reconcileLine(line, poLines, catalog);     // ← the decision, per line
    recoverableUsd += r.recoverableUsd;
    claimedTotal   += line.extension;
    await ctx.db.insert("invoiceLines", { orgId, invoiceId, lineNo: ++lineNo,
      /* LLM-read */ description: line.description, sku: line.sku, unit: line.unit,
      quantity: line.quantity, unitPrice: line.unitPrice, claimedExtension: line.extension,
      confidence: line.confidence, sourceQuote: line.sourceQuote,
      ...r, decision: "pending" });                       // ← spread the computed fields
  }
  return { recoverableUsd: round2(recoverableUsd), claimedTotal: round2(claimedTotal) };
}
```

1. **Loads the tenant's PO lines + catalog** (the baselines) via the `by_org` index.
2. **Clears existing lines first** — this is the idempotency that makes the
   non-retried action safe ([§17](#17-branch-b-the-server-action-extractrun)).
3. **Calls `reconcileLine` per extracted line** and inserts a row that *spreads both
   zones*: the LLM-read fields and `...r` (the computed/decided fields) + `decision:
   "pending"`.
4. **Returns a rollup** (`recoverableUsd`, `claimedTotal`); the caller patches it onto
   the invoice along with `status: "needs_review"` + provider/model/latency/cost.

> **Summary:** one shared write path for *every* source of lines (seed, server
> action, browser Ollama) — so all of them reconcile identically and idempotently.

---

## 21. The trust-critical core (`reconcileLine`)

**File:** [`convex/lib/reconcile.ts`](../convex/lib/reconcile.ts)

`convex/lib/reconcile.ts` — pure functions, no Convex imports, trivially unit-testable.
This is where money decisions happen.

```ts
const RED_PCT = 0.1, YELLOW_PCT = 0.03, MATH_TOL = 0.01, LOW_CONFIDENCE = 0.6, FUZZY_MIN = 0.4;

export function reconcileLine(line, po, catalog) {
  // 1) verify math in CODE — never trust the model's arithmetic
  const computedExtension = round2(line.quantity * line.unitPrice);
  const mathOk = Math.abs(computedExtension - line.extension) <= MATH_TOL + 0.005;

  // 2) match to PO line, then catalog: SKU-exact first, else best fuzzy description (token overlap)
  let matchedBy = "none", poLine, cat;
  if (line.sku) poLine = po.find(p => p.sku === line.sku);
  if (poLine) matchedBy = "sku"; else { /* best overlap() >= FUZZY_MIN */ matchedBy = poLine ? "description" : "none"; }
  // …same for catalog…

  // 3) variance vs each baseline
  const varianceVsPoPct     = variance(poLine?.unitPrice);
  const varianceVsMarketPct = variance(cat?.marketPrice);

  // 4) flag + recoverable $
  let flag = "green"; const escalate = (to) => { if (to==="red") flag="red"; else if (flag==="green") flag="yellow"; };
  if (!mathOk) escalate("red");
  if (matchedBy === "none") escalate("yellow");
  if (line.confidence < LOW_CONFIDENCE) escalate("yellow");
  const worst = Math.max(varianceVsPoPct ?? -Inf, varianceVsMarketPct ?? -Inf);
  if (worst > RED_PCT*100) escalate("red"); else if (worst > YELLOW_PCT*100) escalate("yellow");

  const benchmark = Math.min(poLine?.unitPrice ?? Inf, cat?.marketPrice ?? Inf);   // the LOWER baseline
  const recoverableUsd = (benchmark !== Inf && line.unitPrice > benchmark)
    ? round2((line.unitPrice - benchmark) * line.quantity) : 0;
  return { computedExtension, mathOk, poUnitPrice, catalogPrice, matchedBy, varianceVsPoPct, varianceVsMarketPct, flag, reasons, recoverableUsd };
}
```

1. **Recompute math** (`:74`): `qty × unitPrice`, compared to the printed extension
   within ~1.5¢. Mismatch → red + a reason. *The model's arithmetic is never trusted.*
2. **Match baselines** (`:82`): SKU-exact against the PO, else best fuzzy description
   match via `overlap()` (token-Jaccard, ≥ 0.4). Same against the catalog. Records
   `matchedBy`.
3. **Variance** (`:115`): percent over PO price and over market.
4. **Flag + recoverable** (`:121`): `escalate()` only ratchets up. No match or
   confidence < 0.6 → yellow; worst variance > 10% → red, > 3% → yellow.
   **`recoverableUsd` = overcharge vs the *lower* available baseline, and only when
   actually over** — a conservative figure you can defend to a vendor.

Concrete (`INV-1010`, CBL-12G billed @ $0.95 vs PO $0.78): +21.8% → **red**,
recoverable `(0.95 − 0.78) × 1000 = $170`.

> **Summary:** this pure function is the product. The model's output is only
> *input* to deterministic checks; the flag and the dollar figure come from code you
> can read, test, and defend.

---

## 22. The verdict pushes back to the UI (reactivity)

**Files:** Convex runtime reactivity · queries in [`convex/invoices.ts`](../convex/invoices.ts) · client hooks in [`app/app/page.tsx`](../app/app/page.tsx) & [`app/app/invoices/[id]/page.tsx`](../app/app/invoices/%5Bid%5D/page.tsx)

No "refresh" anywhere. When `writeResults` / `submitExtraction` commits:

1. Convex sees the `invoices` + `invoiceLines` rows changed.
2. It **re-runs every subscribed query** that touches those rows
   (`listInvoices`, `getInvoice`, `stats`) and **pushes the new results** down the
   WebSocket from [§4](#4-appproviderstsx-the-client-boundary--live-connections).
3. The React hooks holding those subscriptions re-render: the dashboard list flips
   from "extracting…" to the verdict + recoverable figure; the detail page's table
   fills with color-coded lines. The eval/diagnostics pages update too if open.

> **Summary:** the UI is a *live projection* of the database. Write on the
> backend → every screen showing that data updates itself. Reactivity replaces
> polling, refetching, and cache invalidation.

---

# Part 5 — Human review, configuration, evaluation

## 23. The invoice detail / review page

**File:** [`app/app/invoices/[id]/page.tsx`](../app/app/invoices/%5Bid%5D/page.tsx)

`app/app/invoices/[id]/page.tsx`:

```tsx
const params = useParams();
const invoiceId = params.id as Id<"invoices">;
const data = useQuery(api.invoices.getInvoice, { invoiceId });   // live subscription for ONE invoice
const reviewLine  = useMutation(api.invoices.reviewLine);
const correctLine = useMutation(api.invoices.correctLine);
const setStatus   = useMutation(api.invoices.setInvoiceStatus);

if (data === undefined) return <p>loading…</p>;   // still loading
if (data === null)      return <p>Not found.</p>;  // wrong tenant or missing
const { invoice, lines } = data;
```

1. **`useParams()`** reads the dynamic `[id]` from the URL ([§1](#1-how-files-become-urls-the-app-router)) — that's how the
   page knows which invoice to load.
2. **`getInvoice` is tenant-checked server-side** — it returns `null` if the invoice's
   `orgId` ≠ yours, so the page renders "Not found" rather than leaking another
   tenant's data. The `undefined` vs `null` distinction = "loading" vs "not allowed."
3. **The table renders each line left→right**: claimed → computed → PO → catalog →
   variance → confidence → flag, with the `reasons` in italics and a left border
   colored by flag (`flagColor`/`flagBg` use inline styles so colors always render).
4. **Per-line controls** (when `decision === "pending"`): approve / correct / reject;
   plus invoice-level Approve/Reject (`setInvoiceStatus`).
5. **`providerLabel()`** turns the stored provider/model into friendly text
   ("extracted by free model (gemma-…)", "extracted in offline mode…").

> **Summary:** the detail page is a live, color-coded audit of one invoice —
> every number shown with both what the vendor claimed and what code computed, plus
> the reasons behind each flag.

---

## 24. `reviewLine` and `correctLine` (an edit re-reconciles)

**File:** [`convex/invoices.ts`](../convex/invoices.ts) (`reviewLine`, `correctLine`, `setInvoiceStatus`)

```ts
export const reviewLine = mutation({                 // approve / reject one line
  args: { lineId, decision: "approved" | "rejected" },
  handler: async (ctx, { lineId, decision }) => {
    const { orgId, who } = await requireOrg(ctx);
    const line = await ctx.db.get(lineId);
    if (!line || line.orgId !== orgId) throw new Error("not found");   // tenant guard
    await ctx.db.patch(lineId, { decision, reviewer: who });
  },
});

export const correctLine = mutation({                // estimator edits the price → RE-RECONCILE
  args: { lineId, unitPrice, quantity? },
  handler: async (ctx, { lineId, unitPrice, quantity }) => {
    const { orgId, who } = await requireOrg(ctx);
    const line = await ctx.db.get(lineId); /* tenant guard */
    const po = …; const catalog = …;
    const qty = quantity ?? line.quantity;
    const r = reconcileLine({ ...line, quantity: qty, unitPrice, extension: round2(qty*unitPrice) }, po, catalog);
    await ctx.db.patch(lineId, { unitPrice, quantity: qty, claimedExtension: round2(qty*unitPrice),
      ...r, decision: "edited", reviewer: who });
  },
});
```

1. **`reviewLine`** just records a human decision + reviewer; every mutation re-checks
   the tenant (`line.orgId !== orgId → throw`).
2. **`correctLine` re-runs `reconcileLine`** on the corrected numbers — so the flag,
   variance, and recoverable update to reflect the fix, and it's marked
   `decision: "edited"`. A correction is both a fix *and* a labeled signal (the same
   pure function, reused a fourth caller).
3. The detail page's `correct()` handler pre-fills the prompt with the agreed PO price
   (else market), so the common "set it to what we agreed" action is one click.

> **Summary:** human edits flow back through the exact same deterministic
> engine — the UI never hand-computes a corrected total; it asks `reconcileLine`.

---

## 25. Routing config (Settings page + `routing.ts`)

**Files:** [`app/app/settings/page.tsx`](../app/app/settings/page.tsx) · [`convex/routing.ts`](../convex/routing.ts)

The Configuration page (`app/app/settings/page.tsx`) lets a tenant choose how
extraction is routed; `convex/routing.ts` persists it.

```ts
// routing.ts
export const get = query({ … });          // current mode/model + key status + resolved activeMode
export const set = mutation({ args: { mode, model? }, … });   // upsert into the `settings` table
export const _forExtract = internalQuery({ args:{orgId}, … }); // read by the action ([§17](#17-branch-b-the-server-action-extractrun))
```

1. **Five modes** (`auto | local | free | paid | offline`), each a provider chain the
   Settings UI spells out explicitly ("Ollama → Anthropic → OpenRouter → Offline" for
   auto, etc.) — mirroring the `order` logic in [§18](#18-provider-routing-llmts--extractlineitems).
2. **`get` also returns live key status** (`keyStatus()`) and the resolved
   `activeMode`, so the page can show which providers are actually available (a key
   set on Convex) vs configured.
3. **`set` upserts** the tenant's `settings` row; **`_forExtract`** is the
   internal query the action reads to route a run.
4. **Provider keys are never in the browser** — the page only selects *which*
   server-side provider a run uses; the note on the page says so.

> **Summary:** routing is per-tenant config in a row, read at extract time —
> the same try-list from [§18](#18-provider-routing-llmts--extractlineitems), made selectable and observable.

---

## 26. Diagnostics (traces, event log, model benchmark)

**Files:** [`app/app/diagnostics/page.tsx`](../app/app/diagnostics/page.tsx) · [`convex/diagnostics.ts`](../convex/diagnostics.ts)

`app/app/diagnostics/page.tsx` + `convex/diagnostics.ts` — the technical view.

1. **Request traces** — a table over `listInvoices` showing provider/model, latency,
   cost, line count, and red/yellow/green per run.
2. **Event log** — `recentLogs` (the `logs` table) rendered as a monospace stream;
   color by level (info/warn/error). Every upload, extract, baseline, benchmark, and
   error appends here.
3. **Model benchmark** — a button that calls the **`benchmark` action**
   (`diagnostics.ts`), which runs one sample invoice through *every* routing mode
   (`offline/local/free/paid`) and returns provider, latency, and lines recovered for
   each — a live comparison. It's an action because it makes external calls; results
   are returned directly to the page via `useAction` (not stored), plus a summary log.

> **Summary:** Diagnostics is the "show me the machine" tab — the same data
> the product uses, surfaced as traces, logs, and a head-to-head model benchmark.

---

## 27. Evals (the CI gate, `evals.ts`)

**Files:** [`convex/evals.ts`](../convex/evals.ts) · [`app/app/evals/page.tsx`](../app/app/evals/page.tsx) · labels in [`convex/lib/demoData.ts`](../convex/lib/demoData.ts)

```ts
export const runEval = mutation({
  handler: async (ctx) => {
    const { orgId } = await requireOrg(ctx);
    const invoices = await ctx.db.query("invoices").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
    let tp=0, fp=0, fn=0, n=0, mathConsistent=0, totalLines=0;
    for (const inv of invoices) {
      const truth = DEMO_EVAL_LABELS[inv.invoiceNumber];     // labeled "should it flag red?"
      const lines = await ctx.db.query("invoiceLines").withIndex("by_invoice", q => q.eq("invoiceId", inv._id)).collect();
      totalLines += lines.length; mathConsistent += lines.filter(l => l.mathOk).length;
      if (truth === undefined) continue;
      n++; const predicted = lines.some(l => l.flag === "red");
      if (predicted && truth) tp++; else if (predicted && !truth) fp++; else if (!predicted && truth) fn++;
    }
    const precision = tp+fp===0 ? 1 : tp/(tp+fp);
    const recall    = tp+fn===0 ? 1 : tp/(tp+fn);
    const extractionAccuracy = totalLines===0 ? 1 : mathConsistent/totalLines;
    return await ctx.db.insert("evalRuns", { orgId, provider:"engine", model:"reconcile-v1", n, extractionAccuracy, flagPrecision:precision, flagRecall:recall });
  },
});
```

1. **Scores the flag *engine*, not the model.** Truth = "this invoice should surface a
   red flag" (from `DEMO_EVAL_LABELS`); prediction = "any red line." Accumulates
   TP/FP/FN → precision & recall.
2. **`extractionAccuracy`** = math-consistency (share of lines whose printed total
   matches qty×price) — a check the deterministic code performs.
3. **The Evals page** frames *why* it matters: a false negative lets padding through
   (lost money); a false positive makes estimators distrust the tool. This is the gate
   you'd run in CI before shipping a threshold/prompt/model change.

> **Summary:** accuracy is *measured*, not asserted. The decision logic's
> quality is provable independently of whatever LLM did the reading.

---

# Part 6 — The shared pieces + the big picture

## 28. Shared UI (`ui.tsx`, `nav.tsx`)

**Files:** [`app/components/ui.tsx`](../app/components/ui.tsx) · [`app/components/nav.tsx`](../app/components/nav.tsx)

1. **`app/components/ui.tsx`** — tiny shared helpers: `usd()` (currency formatting,
   `—` for null), `FlagBadge` / `StatusBadge` (the colored pills), and `cn()`
   (clsx + tailwind-merge for conditional classes). Pure presentation.
2. **`app/components/nav.tsx`** (`"use client"`) — the app nav: links to
   Dashboard/Evals/Diagnostics/Configuration/About, plus Clerk's
   `<OrganizationSwitcher>` (switch tenant) and `<UserButton>` (account), a
   `ThemeToggle`, and the `AppLauncher` (the ⌘K cross-project launcher shared by the
   portfolio).
3. **`ThemeToggle`** mirrors the layout's bootstrap script: it reads/sets
   `localStorage["theme"]` and toggles the `light` class, starting as `null` until
   mounted so SSR markup matches (avoiding the hydration mismatch on the icon).

> **Summary:** the shared components keep every page visually consistent and
> carry the cross-tenant (org switcher) and cross-project (launcher) chrome.

---

## 29. Build & deploy: the three planes

**Files:** [`next.config.ts`](../next.config.ts) · full detail in [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)

(Full detail in `DEPLOYMENT.md`; the essentials.)

```
Browser ──Clerk JS──► Next.js on RENDER ──NEXT_PUBLIC_CONVEX_URL + JWT──► CONVEX CLOUD ──fetch──► LLM
            │                                                                │
            └──────────────► CLERK CLOUD ◄──verify issuer (auth.config)──────┘
```

1. **Render** runs the Next app (`npm run build` → `next start`). Holds only the
   *public* Convex URL + Clerk keys. **Never holds an LLM key.**
2. **Convex Cloud** runs the DB + all functions + the scheduler + the extract action.
   **All LLM keys live here** (`OPENROUTER_API_KEY` etc., set via `npx convex env
   set`) because that's where the action runs.
3. **Clerk Cloud** runs auth + orgs and issues the JWT Convex trusts.
4. **Build vs runtime:** at build, Next compiles routes and inlines `NEXT_PUBLIC_*`
   into the browser bundle; at runtime, the Node server serves SSR/RSC. The most
   common deploy mistake is putting an LLM key on Render — it does nothing there.
5. With **no** LLM key anywhere, extraction still works via the deterministic
   fallback ([§18](#18-provider-routing-llmts--extractlineitems)) — $0, fully offline.

> **Summary:** three managed planes, joined by a public URL and a signed JWT;
> secrets live where the code that needs them runs (LLM keys on Convex, never the
> browser or Render).

---

## 30. The whole machine, end to end

**Files:** the whole tree — see the [Source map](#source-map) for every file + link

The complete path, in one breath:

```
Request → middleware (gate /app)
        → layout (shell + theme) → providers (one Convex socket + Clerk)
        → page renders (server HTML) → browser hydrates → live queries subscribe
Sign in → Clerk cookie (door) + Convex JWT (data); auth.config trusts the issuer
Upload  → read file in browser → createInvoiceFromText (atomic, status "extracting")
        ├─ Branch A: browser→host Ollama → submitExtraction
        └─ Branch B: schedule extract.run (action) → extractLineItems (paid→free→offline)
        → BOTH funnel to insertReconciledLines → reconcileLine (the money decision, in code)
        → write rows (idempotent) → Convex PUSHES updates → every open screen re-renders
Review  → reviewLine / correctLine (re-reconciles) → live update
Prove   → runEval scores flag precision/recall on labeled data
```
