"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "./ui";

// Portfolio demo catalog (live *.onrender.com links). Inlined so the launcher
// is self-contained and works in every deployment.
type App = { name: string; tag: string; url: string };

const APPS: App[] = [
  { name: "persona-twin", tag: "RAG digital-twins: chunking/embedding/rerank, eval, streaming chat, ob…", url: "https://persona-twin-usu4.onrender.com" },
  { name: "tanglement-showcase", tag: "P2P multi-provider LLM routing network (proprietary showcase)", url: "https://tanglement-teaser.onrender.com" },
  { name: "pii-redactor", tag: "PII detect/redact — regex+checksum core + LLM NER", url: "https://pii-redactor-lk6x.onrender.com" },
  { name: "evalkit", tag: "Offline-first LLM eval toolkit + LLM-judge + regression gate", url: "https://evalkit-2ptv.onrender.com" },
  { name: "doc-extract", tag: "Schema-driven extraction + provenance + LLM fill", url: "https://doc-extract-oyuj.onrender.com" },
  { name: "agent-sandbox", tag: "ReAct agent over safe tools — rule or LLM planner", url: "https://agent-sandbox-jp4b.onrender.com" },
  { name: "promptguard", tag: "LLM-firewall: injection/secret/PII + LLM classifier", url: "https://promptguard-oiqr.onrender.com" },
  { name: "synth-data", tag: "Deterministic PII-free synthetic data + LLM fields", url: "https://synth-data.onrender.com" },
  { name: "forecast", tag: "Classic-ML forecasting + anomalies (no-LLM core)", url: "https://forecast-h6uf.onrender.com" },
  { name: "multimodal-ocr", tag: "OCR → PII → box-level redaction + LLM NER", url: "https://multimodal-ocr-x2g3.onrender.com" },
  { name: "reconcile", tag: "Document line-item reconciliation — extract → diff vs baseline + marke…", url: "https://reconcile-gfuj.onrender.com" },
  { name: "llm-gateway", tag: "Provider-agnostic LLM gateway — firewall + PII/secret redaction + rout…", url: "https://llm-gateway-jwsq.onrender.com" },
  { name: "slo-kit", tag: "Instrumented SRE reference — RED metrics, SLOs + error budgets, traces…", url: "https://slo-kit.onrender.com" },
  { name: "field-vault", tag: "Field-level de-identification + least-privilege access + tamper-eviden…", url: "https://field-vault.onrender.com" },
  { name: "rtc-guard", tag: "Scoped WebRTC access tokens + adversarial test suite + AV-pipeline thr…", url: "https://rtc-guard.onrender.com" },
  { name: "rate-atlas", tag: "Normalize inconsistent price-transparency files → one model; compare n…", url: "https://rate-atlas.onrender.com" },
  { name: "attack-surface", tag: "CT-log enumeration → service fingerprint → SOC 2 / ISO 27001 control-m…", url: "https://attack-surface.onrender.com" },
  { name: "txn-ledger", tag: "High-volume contributions store — partitioned schema, query-plan tunin…", url: "https://txn-ledger.onrender.com" },
  { name: "agent-factory", tag: "Build a tool-using agent from a declarative spec — template-simple or…", url: "https://agent-factory-ov8r.onrender.com" },
  { name: "trueline", tag: "Invoice line-item verification — LLM extract → verify math in code → r…", url: "https://trueline-moys.onrender.com" },
  { name: "postureline", tag: "Security posture & compliance — one engine, two scanners: warehouse (S…", url: "https://postureline.onrender.com" },
  { name: "relaytoken", tag: "Scoped WebRTC room access tokens on the livekit/protocol auth lib + 8/…", url: "https://relaytoken.onrender.com" },
  { name: "cycleledger", tag: "High-volume contributions data layer — Postgres cycle-partitioning, FE…", url: "https://cycleledger.onrender.com" },
  { name: "quorum", tag: "Vendor-neutral multi-agent orchestrator — workflow DAG + parallel fan-…", url: "https://quorum.onrender.com" },
  { name: "burnrate", tag: "Instrumented Flask SRE service — Prometheus RED metrics, multi-window…", url: "https://burnrate-grza.onrender.com" },
  { name: "baseplate", tag: "Platform paved-road — reusable Terraform/EKS/RDS + ArgoCD + golden CI,…", url: "https://baseplate-mlrj.onrender.com" },
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function AppLauncher() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [currentHost, setCurrentHost] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Resolve the current host only on the client; "here" is meaningful only on
  // the live onrender deployments.
  useEffect(() => {
    const h = window.location.hostname;
    setCurrentHost(h.includes("onrender") ? h : null);
  }, []);

  // Esc closes; focus the filter when the modal opens.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function isCurrent(url: string): boolean {
    return currentHost !== null && hostOf(url) === currentHost;
  }

  const q = filter.trim().toLowerCase();
  const shown = APPS.filter(
    (a) => !q || (a.name + " " + a.tag).toLowerCase().includes(q),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFilter("");
          setOpen(true);
        }}
        aria-label="Browse all portfolio demos"
        aria-haspopup="dialog"
        title="Browse all demos"
        className="rounded-md px-2 py-1 text-[--color-muted] hover:text-[--color-ink]"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          width={18}
          height={18}
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Portfolio demos"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          className="fixed inset-0 z-[95] flex items-start justify-center bg-black/50 px-4 py-[6vh] backdrop-blur-sm"
        >
          <div className="glass flex max-h-[84vh] w-full max-w-[920px] flex-col overflow-hidden">
            <div className="flex items-center gap-3 border-b border-[--color-line] px-4 py-3">
              <b className="text-sm">Portfolio demos</b>
              <span className="text-xs text-[--color-muted]">
                {APPS.length} apps
              </span>
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                aria-label="Filter demos"
                className="ml-auto w-full max-w-[260px] rounded-md border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_4%,_transparent)] px-2 py-1 text-sm text-[--color-ink] placeholder:text-[--color-muted]"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md px-2 py-1 text-[--color-muted] hover:text-[--color-ink]"
              >
                ✕
              </button>
            </div>

            <div
              className="grid gap-2.5 overflow-auto p-4"
              style={{
                gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))",
              }}
            >
              {shown.length === 0 ? (
                <div className="p-2 text-sm text-[--color-muted]">No match.</div>
              ) : (
                shown.map((a) => {
                  const cur = isCurrent(a.url);
                  return (
                    <a
                      key={a.name}
                      href={a.url}
                      className={cn(
                        "relative block rounded-[--radius] border border-[--color-line] bg-[color-mix(in_oklch,_var(--color-ink)_4%,_transparent)] p-3 no-underline",
                        "transition hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,_var(--color-accent)_40%,_var(--color-line))] hover:shadow-lg",
                        cur &&
                          "border-[--color-accent] shadow-[0_0_0_1px_var(--color-accent)]",
                      )}
                    >
                      {cur && (
                        <span className="absolute right-2 top-2 rounded-full bg-[--color-accent] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[--color-accent-ink]">
                          here
                        </span>
                      )}
                      <div className="flex items-center gap-2 text-sm font-semibold text-[--color-ink]">
                        <span
                          className="flagdot bg-[--color-accent]"
                          aria-hidden="true"
                        />
                        {a.name}
                      </div>
                      <div className="mt-1.5 text-xs leading-snug text-[--color-muted]">
                        {a.tag}
                      </div>
                    </a>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
