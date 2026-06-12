"""Threat model for a human↔AI real-time (WebRTC) pipeline.

Structured so it can be served, rendered, and diffed — a threat model that lives in
code, not a doc that rots. Each entry maps a concrete threat on the audio/video
path to its mitigation and notes which rtc-guard control (if any) demonstrates it.
"""

THREATS: list[dict] = [
    {
        "id": "T1", "category": "token", "title": "Access-token replay",
        "threat": "A leaked join token is reused to enter a room or impersonate a "
                  "participant.",
        "mitigation": "Short TTLs + nbf; per-identity scoping; optional single-use "
                      "jti so a token can't be replayed.",
        "control": "token.mint (TTL/nbf) + verify(jti_store) — see adversary T1/T7",
    },
    {
        "id": "T2", "category": "token", "title": "Grant escalation / forgery",
        "threat": "A subscriber tampers with the grant to gain publish, or forges a "
                  "token with their own key.",
        "mitigation": "HS256 signature over the whole grant; least-privilege grant "
                      "templates; never honor alg=none.",
        "control": "token.verify signature check — see adversary T3/T4/T5",
    },
    {
        "id": "T3", "category": "room", "title": "Room hijack / cross-room replay",
        "threat": "A token minted for one room is presented to another, or an "
                  "attacker joins a room they were never scoped to.",
        "mitigation": "Room is part of the signed grant; verify against the expected "
                      "room; rooms are not guessable identifiers.",
        "control": "token.verify(expected_room) — see adversary T6",
    },
    {
        "id": "T4", "category": "media", "title": "Media eavesdropping",
        "threat": "An on-path attacker captures the audio/video stream.",
        "mitigation": "SRTP with DTLS-SRTP key exchange on every media path; "
                      "end-to-end encryption for sensitive rooms.",
        "control": "transport-level (documented); out of scope for the token service",
    },
    {
        "id": "T5", "category": "egress", "title": "Recording / egress exposure",
        "threat": "Room recordings or egress streams are written to storage that's "
                  "broader than the room's audience.",
        "mitigation": "Customer-controlled recording encryption; egress writes scoped "
                      "to least-privilege storage creds; audit who started egress.",
        "control": "policy/runbook (documented); egress requires a separate grant",
    },
    {
        "id": "T6", "category": "agent",
        "title": "Prompt injection over the data channel",
        "threat": "A participant sends data-channel messages that manipulate the AI "
                  "agent (exfiltration, jailbreak) as if they were instructions.",
        "mitigation": "Treat data-channel input as untrusted; scan/redact before the "
                      "LLM (an llm-gateway-style firewall); separate system context.",
        "control": "cross-refs the llm-gateway firewall; canPublishData is grant-gated",
    },
    {
        "id": "T7", "category": "server", "title": "SFU / signaling trust",
        "threat": "A compromised or rogue media server downgrades encryption or mirrors "
                  "streams.",
        "mitigation": "Pin trusted server identities; mutual auth on signaling; monitor "
                      "for unexpected SSRCs/participants; minimal server retention.",
        "control": "architecture (documented)",
    },
    {
        "id": "T8", "category": "dos", "title": "Join flood / resource exhaustion",
        "threat": "Mass token requests or joins exhaust room/SFU capacity.",
        "mitigation": "Rate-limit minting; per-identity caps; short TTLs limit the "
                      "blast radius of any one leaked credential.",
        "control": "mint policy (documented)",
    },
]


def threat_model() -> dict:
    by_cat: dict[str, int] = {}
    for t in THREATS:
        by_cat[t["category"]] = by_cat.get(t["category"], 0) + 1
    return {"threats": THREATS, "count": len(THREATS), "by_category": by_cat}
