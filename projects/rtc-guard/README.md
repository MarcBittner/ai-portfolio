# rtc-guard

**Scoped access tokens + an adversarial test suite + a threat model** for human↔AI
real-time (WebRTC) pipelines — the security layer under voice agents. A
least-privilege JWT token service that mirrors the LiveKit access-token model
(a signed `video` grant: room, join, publish/subscribe, data, short TTL, jti),
then the **breaker** half: a suite that tries to forge, replay, escalate, and
downgrade those tokens and proves each attack fails — plus a threat model of the
audio/video path and a minimal voice-agent sample showing the secure integration.

> Builder **and** breaker. The security core (mint / verify / adversarial suite /
> threat model) is offline, deterministic, no secrets, and runs as the live demo.
> The voice agent (mic→STT→LLM→TTS) is a documented **self-host sample** — it needs
> a LiveKit server + STT/LLM/TTS keys, so it isn't part of the hosted demo.

## What it shows

- **Least-privilege tokens.** Grant templates (`viewer`, `publisher`, `agent`,
  `data_only`) — a token only carries the capabilities it needs, signed into the
  JWT, with a short TTL and a `nbf`/`jti`.
- **Adversarial suite (8 attacks, all blocked).** expired reuse · used-before-nbf ·
  payload tamper to escalate · forged signature · `alg=none` strip ·
  cross-room replay · single-use replay · capability confinement. Run it at
  `/adversary` — it's a regression test for the defenses, not a claim.
- **Threat model in code** (`/threat-model`): token replay, grant forgery, room
  hijack, media eavesdropping, egress/recording exposure, **data-channel prompt
  injection** into the agent, SFU trust, join-flood DoS — each mapped to its
  mitigation and the control that demonstrates it.
- **Secure agent integration** (`samples/voice_agent.py`): the agent joins with a
  freshly-minted, scoped, short-TTL token and treats data-channel input as
  untrusted (firewall before the LLM).

## Quickstart

```sh
cd projects/rtc-guard
./run.sh setup
./run.sh demo            # offline: mint + verify + adversarial suite + threat model
./run.sh serve           # token console at http://127.0.0.1:8013
./run.sh test            # unit suite
./run.sh smoke           # live smoke/regression (local server, or --url <deploy>)
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, template + threat counts |
| GET | `/templates` | the least-privilege grant templates |
| POST | `/v1/token` | mint a scoped token → token + decoded grant |
| POST | `/v1/verify` | verify signature / TTL / room scope → valid + reason |
| GET | `/adversary` | run the adversarial suite (every attack blocked) |
| GET | `/threat-model` | the AV-pipeline threat model |
| GET | `/sample/voice-agent` | the self-host voice-agent reference |

`POST /v1/token` body: `{ "identity": "alice", "room": "room-a",
"template": "publisher", "ttl": 300 }`.

Proprietary, offline-first, no secrets — conforms to the portfolio conventions
(CONV-1…5).
