# rtc-guard — Development Plan

**Legend:** `[x]` complete · `[>]` in progress · `[ ]` pending

## Phase 0 — MVP (v0.1.0) ✅

- [x] Scaffold (pyproject, run.sh w/ smoke, Dockerfile, LICENSE)
- [x] Hand-rolled HS256 JWT (encode/decode, stdlib only)
- [x] Scoped token mint (LiveKit-style video grants + least-privilege templates +
      TTL/nbf/jti) and verify (signature, window, room scope, single-use replay)
- [x] Adversarial suite — 8 attacks, all blocked
- [x] AV-pipeline threat model in code (token/room/media/egress/agent/server/DoS)
- [x] Self-host voice-agent sample (scoped-token + data-channel guard)
- [x] FastAPI (`/v1/token`, `/v1/verify`, `/adversary`, `/threat-model`,
      `/templates`, `/sample/voice-agent`) + token-console UI
- [x] Tests: token / adversary / threat-model / api + local+remote smoke
- [x] ruff clean, `./run.sh demo` offline, smoke green

## Roadmap

- [ ] Asymmetric signing (RS256/EdDSA) + key rotation / JWKS
- [ ] Mint rate-limiting + per-identity caps (DoS hardening, threat T8)
- [ ] Token revocation list / introspection endpoint
- [ ] Runnable end-to-end voice demo against a self-hosted LiveKit (opt-in)
- [ ] Deploy live on Render (free) + add to the portfolio "Live demos" table
