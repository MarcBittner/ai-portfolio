# attack-surface

Turn attack-surface enumeration into **governed, auditable evidence**: discover
an org's exposed assets (subdomains from **Certificate Transparency**, services +
fingerprints), then map every finding to a **SOC 2 / ISO 27001 control** with a
status, remediation, and a posture score. The bridge from *"we found an
exposure"* to *"here is the control it affects and how we'll prove we handled it."*

> **Fixture mode** (default, offline, deterministic) runs the **full** report on
> an owned synthetic domain (`example-corp.test`) — that's the hosted demo.
> **Live mode** does **passive CT-log recon only** (reads public certificates) on
> a real domain — never active scanning of hosts you don't own. All fixture data
> is synthetic; no secrets.

## The loop

```
CT logs → subdomains ─▶ service fingerprint ─▶ findings (severity + remediation)
                                                   │
                       map each finding → SOC 2 / ISO 27001 control ─▶ control coverage + posture grade
```

The owned-domain fixture surfaces: an **unauthenticated admin panel** and an
**internet-exposed database** (critical), a **dangling subdomain** (takeover) and
an **expired TLS cert** (high), permissive CORS / non-prod exposure / plaintext
SMTP (medium), missing HSTS (low) — then rolls them up to **7 of 8 controls
failing**, posture **grade D**.

## Quickstart

```sh
cd projects/attack-surface
./run.sh setup
./run.sh demo            # offline: full control-mapped exposure report
./run.sh serve           # report UI at http://127.0.0.1:8015
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, control + fixture-finding counts |
| GET | `/controls` | the SOC 2 / ISO 27001 control catalog |
| GET | `/scan` | the fixture exposure report (assets, findings, controls, posture) |
| POST | `/scan` | `{mode:"fixture"}` full report · `{mode:"live","domain":"…"}` passive CT recon |

`GET /scan` → `{ assets, findings[], severity_counts, controls[], posture }` —
each finding carries its mapped control ids + a remediation.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
