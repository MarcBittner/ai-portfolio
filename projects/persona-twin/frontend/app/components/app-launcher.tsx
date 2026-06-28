import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";

type App = { name: string; tag: string; url: string };

// Single source of truth is catalog.json (repo root), served via jsDelivr and
// fetched at runtime; this inlined list is only an offline fallback.
const CATALOG_URL =
  "https://cdn.jsdelivr.net/gh/MarcBittner/ai-portfolio@main/catalog.json";
const FALLBACK: App[] = [
  { name: "persona-twin", tag: "RAG digital-twins: chunking/embedding/rerank, eval, streaming chat, ob…", url: "https://persona-twin-s4nj.onrender.com" },
  { name: "tanglement-showcase", tag: "P2P multi-provider LLM routing network (proprietary showcase)", url: "https://tanglement-teaser-2v61.onrender.com" },
  { name: "pii-redactor", tag: "PII detect/redact — regex+checksum core + LLM NER", url: "https://pii-redactor-t3aw.onrender.com" },
  { name: "evalkit", tag: "Offline-first LLM eval toolkit + LLM-judge + regression gate", url: "https://evalkit-b3fz.onrender.com" },
  { name: "doc-extract", tag: "Schema-driven extraction + provenance + LLM fill", url: "https://doc-extract-h68a.onrender.com" },
  { name: "agent-sandbox", tag: "ReAct agent over safe tools — rule or LLM planner", url: "https://agent-sandbox-2unn.onrender.com" },
  { name: "promptguard", tag: "LLM-firewall: injection/secret/PII + LLM classifier", url: "https://promptguard-p9y0.onrender.com" },
  { name: "synth-data", tag: "Deterministic PII-free synthetic data + LLM fields", url: "https://synth-data-4amp.onrender.com" },
  { name: "forecast", tag: "Classic-ML forecasting + anomalies (no-LLM core)", url: "https://forecast-b8zt.onrender.com" },
  { name: "multimodal-ocr", tag: "OCR → PII → box-level redaction + LLM NER", url: "https://multimodal-ocr-ty8t.onrender.com" },
  { name: "reconcile", tag: "Document line-item reconciliation — extract → diff vs baseline + marke…", url: "https://reconcile-vx21.onrender.com" },
  { name: "llm-gateway", tag: "Provider-agnostic LLM gateway — firewall + PII/secret redaction + rout…", url: "https://llm-gateway-7woj.onrender.com" },
  { name: "slo-kit", tag: "Instrumented SRE reference — RED metrics, SLOs + error budgets, traces…", url: "https://slo-kit.onrender.com" },
  { name: "field-vault", tag: "Field-level de-identification + least-privilege access + tamper-eviden…", url: "https://field-vault.onrender.com" },
  { name: "rtc-guard", tag: "Scoped WebRTC access tokens + adversarial test suite + AV-pipeline thr…", url: "https://rtc-guard-wpbe.onrender.com" },
  { name: "rate-atlas", tag: "Normalize inconsistent price-transparency files → one model; compare n…", url: "https://rate-atlas.onrender.com" },
  { name: "attack-surface", tag: "CT-log enumeration → service fingerprint → SOC 2 / ISO 27001 control-m…", url: "https://attack-surface-wg5r.onrender.com" },
  { name: "txn-ledger", tag: "High-volume contributions store — partitioned schema, query-plan tunin…", url: "https://txn-ledger-iyfi.onrender.com" },
  { name: "agent-factory", tag: "Build a tool-using agent from a declarative spec — template-simple or…", url: "https://agent-factory-ohkl.onrender.com" },
  { name: "trueline", tag: "Invoice line-item verification — LLM extract → verify math in code → r…", url: "https://trueline-dcqc.onrender.com" },
  { name: "postureline", tag: "Security posture & compliance — one engine, two scanners: warehouse (S…", url: "https://postureline-3a8z.onrender.com" },
  { name: "relaytoken", tag: "Scoped WebRTC room access tokens on the livekit/protocol auth lib + 8/…", url: "https://relaytoken-9p78.onrender.com" },
  { name: "cycleledger", tag: "High-volume contributions data layer — Postgres cycle-partitioning, FE…", url: "https://cycleledger-8xg3.onrender.com" },
  { name: "quorum", tag: "Vendor-neutral multi-agent orchestrator — workflow DAG + parallel fan-…", url: "https://quorum-71pl.onrender.com" },
  { name: "burnrate", tag: "Instrumented Flask SRE service — Prometheus RED metrics, multi-window…", url: "https://burnrate-v8sp.onrender.com" },
  { name: "baseplate", tag: "Platform paved-road — reusable Terraform/EKS/RDS + ArgoCD + golden CI,…", url: "https://baseplate-b0ag.onrender.com" },
  { name: "arbiter", tag: "AI request gateway — sits in front of your apps' real LLM traffic; routes/caches for cost savings gated by measured quality", url: "https://routelens-0kxz.onrender.com" },
];

// Mark the current app by comparing the live host — only meaningful on the
// deployed *.onrender.com origins (no false "here" badge in local dev).
function isCurrent(url: string): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (host.indexOf("onrender") === -1) return false;
  try {
    return new URL(url).hostname === host;
  } catch {
    return false;
  }
}

export function AppLauncher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const [apps, setApps] = useState<App[]>(FALLBACK);
  const searchRef = useRef<HTMLInputElement>(null);

  // Single source of truth: pull the live catalog at runtime; keep FALLBACK if
  // it's unreachable. Adding/renaming a demo never touches this file.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    fetch(CATALOG_URL, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (Array.isArray(j) && j.length) setApps(j as App[]);
      })
      .catch(() => {})
      .finally(() => clearTimeout(t));
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    // focus the filter on open
    requestAnimationFrame(() => searchRef.current?.focus());
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => (a.name + " " + a.tag).toLowerCase().includes(q));
  }, [filter, apps]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 py-[6vh] backdrop-blur-sm transition-opacity",
        open ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden={!open}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Portfolio demos"
        className={cn(
          "flex max-h-[84vh] w-full max-w-[920px] flex-col overflow-hidden rounded-xl",
          "border border-border bg-card text-card-foreground shadow-xl backdrop-blur-xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-y-0" : "-translate-y-3",
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <b className="text-sm font-semibold">Portfolio demos</b>
          <span className="text-xs text-muted-foreground">{apps.length} apps</span>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            aria-label="Filter demos"
            className="ml-auto w-full max-w-[260px] rounded-md border border-border bg-card px-3 py-1.5 text-sm"
          />
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            ✕
          </button>
        </header>

        <div
          className="grid gap-2.5 overflow-y-auto p-4"
          style={{ gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}
        >
          {shown.map((a) => {
            const cur = isCurrent(a.url);
            return (
              <a
                key={a.name}
                href={a.url}
                aria-current={cur ? "page" : undefined}
                className={cn(
                  "group relative block rounded-md border border-border bg-card/60 p-3 no-underline",
                  "transition-[transform,border-color,box-shadow] duration-200",
                  "hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg",
                  cur && "border-primary shadow-[0_0_0_1px_var(--color-primary)]",
                )}
              >
                {cur && (
                  <span className="absolute right-2 top-2 rounded-full bg-primary px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-primary-foreground">
                    here
                  </span>
                )}
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
                  {a.name}
                </div>
                <div className="mt-1.5 text-xs leading-snug text-muted-foreground">
                  {a.tag}
                </div>
              </a>
            );
          })}
          {shown.length === 0 && (
            <div className="p-2 text-sm text-muted-foreground">No match.</div>
          )}
        </div>
      </div>
    </div>
  );
}
