# rtc-guard — Specification

## Overview

A security reference for human↔AI real-time (WebRTC) pipelines: a least-privilege
JWT access-token service modeled on LiveKit's grant tokens, an adversarial suite
that proves the tokens resist forgery/replay/escalation, an AV-pipeline threat
model in code, and a self-host voice-agent sample showing the secure integration.
The token core is offline and deterministic.

## Functional requirements

- **FR-1 Scoped tokens.** Mint HS256 JWTs carrying a signed `video` grant (room,
  roomJoin, canPublish, canSubscribe, canPublishData) from least-privilege
  templates, with `iat`/`nbf`/`exp` (short TTL) and a `jti`.
- **FR-2 Verification.** Check signature, validity window, room scope, roomJoin;
  optional single-use replay via a jti store.
- **FR-3 Adversarial suite.** Expired reuse, used-before-nbf, payload tamper to
  escalate, forged signature, `alg=none` strip, cross-room replay, single-use
  replay, capability confinement — every attack must be blocked.
- **FR-4 Threat model.** Structured threats on the AV path (token, room, media,
  egress, agent/data-channel, server, DoS) each mapped to mitigation + control.
- **FR-5 Secure agent sample.** A documented voice agent (mic→STT→LLM→TTS) that
  joins with a scoped, short-TTL token and firewalls untrusted data-channel input.
- **FR-6 API + UI.** FastAPI (`/v1/token`, `/v1/verify`, `/adversary`,
  `/threat-model`, `/templates`, `/sample/voice-agent`) + a token console.
- **FR-7 Offline + safe.** Token core needs no network and no real secrets (a demo
  signing key, env-overridable); the voice loop is an opt-in self-host sample.

## Architecture

```
token.py     — HS256 encode/decode, mint(template,ttl), verify(room,jti), can()
adversary.py — constructs each attack against token.py, asserts it's blocked
threat_model.py — AV-path threats → mitigation → control
samples/voice_agent.py — self-host LiveKit agent; mints a scoped token via token.py
```

## Conventions

Proprietary, offline-first, no secrets — conforms to the portfolio's CONV-1…5.
