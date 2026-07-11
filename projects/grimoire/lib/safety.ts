// Content-safety scanner — flags material that shouldn't be exposed team-wide:
// real secret VALUES, PII / HR data, personal contact info, and offensive
// language. Pure + dependency-free so it runs in a server action, at ingest time,
// and in tests. It intentionally IGNORES docs that merely *describe* configuration
// (env-var names, "ask your manager for the password manager") — those are
// legitimate engineering docs, not leaked secrets.

export type Severity = "critical" | "high" | "medium" | "low";

export interface SafetyHit {
  severity: Severity;
  label: string;
  context: string; // a short redacted-ish snippet around the match
}

interface Rule {
  severity: Severity;
  label: string;
  re: RegExp;
}

const RULES: Rule[] = [
  // --- real secret VALUES (not mentions of env-var names) ---
  { severity: "critical", label: "Anthropic API key", re: /sk-ant-[a-z0-9-]{20,}/gi },
  { severity: "critical", label: "OpenAI/OpenRouter key", re: /sk-(?:proj-|or-v1-)?[a-z0-9]{24,}/gi },
  { severity: "critical", label: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
  { severity: "critical", label: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { severity: "critical", label: "Slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { severity: "critical", label: "GitHub token", re: /gh[pousr]_[0-9A-Za-z]{30,}/g },
  { severity: "critical", label: "Stripe live secret", re: /sk_live_[0-9A-Za-z]{20,}/g },
  { severity: "critical", label: "Mongo URI with credentials", re: /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@/gi },
  { severity: "critical", label: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { severity: "critical", label: "assigned secret/password value", re: /\b(?:pass(?:word|wd)?|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*_\-]{8,}/gi },
  // --- PII / HR (contextual, not bare numbers) ---
  { severity: "high", label: "US SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { severity: "high", label: "credit-card-like number", re: /\b(?:\d[ -]?){15,16}\b/g },
  { severity: "high", label: "HR / compensation terms", re: /\b(offer letter|base salary|annual salary|equity grant|stock option grant|severance|termination for cause|performance improvement plan|\bPIP\b|written warning|disciplinary action|social security number|date of birth|home address)\b/gi },
  { severity: "medium", label: "personal phone number", re: /\b(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  // --- offensive language (human-review; never auto-acted) ---
  { severity: "medium", label: "profanity", re: /\b(?:fuck(?:ing|er)?|shit|bitch|asshole|dickhead|bastard|motherfucker)\b/gi },
  // --- distribution markers ---
  { severity: "low", label: "restricted-distribution marker", re: /\b(?:strictly confidential|do not (?:share|distribute)|not for distribution|eyes only)\b/gi },
];

// Snippets whose surroundings indicate documentation-of-config, not a real secret.
const ALLOW =
  /process\.env|<[A-Z_]{2,}>|\benv(?:ironment)? var|ask (?:your )?manager|password manager|\bJWT_SECRET\b|\bR2_(?:ACCESS|SECRET)_KEY\b|\bSTRIPE_(?:SECRET|WEBHOOK)_KEY\b|x-api-key:\s*\$|_API_KEY\b(?!\s*[:=]\s*["']?[A-Za-z0-9])|_SECRET_KEY\b(?!\s*[:=]\s*["']?[A-Za-z0-9])/i;

function snippet(text: string, index: number, len: number): string {
  const raw = text.slice(Math.max(0, index - 30), index + len + 30).replace(/\s+/g, " ").trim();
  // Redact long secret-like tokens and SSNs so the audit never echoes a live
  // secret back into the UI / logs.
  return raw
    .replace(/[A-Za-z0-9_-]{12,}/g, (t) => t.slice(0, 4) + "…" + t.slice(-2))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "***-**-****");
}

/** Scan text and return safety hits (empty = clean). Config-describing lines are
 *  filtered out to avoid false positives on legitimate engineering docs. */
export function scanContent(text: string): SafetyHit[] {
  if (!text) return [];
  const hits: SafetyHit[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const ctx = snippet(text, m.index ?? 0, m[0].length);
      if (ALLOW.test(ctx)) continue;
      hits.push({ severity: rule.severity, label: rule.label, context: ctx.slice(0, 160) });
    }
  }
  return hits;
}

const ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Highest severity present in a set of hits (null if clean). */
export function worstSeverity(hits: SafetyHit[]): Severity | null {
  if (hits.length === 0) return null;
  return hits.reduce((w, h) => (ORDER[h.severity] < ORDER[w] ? h.severity : w), hits[0].severity);
}
