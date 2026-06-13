// Package threatmodel is the static, reviewable WebRTC / realtime-AI threat model:
// each entry maps a threat to its mitigation and the concrete control in this
// service (or the surrounding system) that implements it.
package threatmodel

// Entry is one row of the threat model.
type Entry struct {
	ID         string `json:"id"`
	Threat     string `json:"threat"`
	Vector     string `json:"vector"`
	Mitigation string `json:"mitigation"`
	Control    string `json:"control"`
}

// Model returns the full threat model.
func Model() []Entry {
	return []Entry{
		{
			ID:         "TM-1",
			Threat:     "Data-channel prompt injection into the voice-AI agent",
			Vector:     "A participant publishes crafted text on the data channel that the AI agent treats as instructions, hijacking its behavior.",
			Mitigation: "Scope canPublishData to roles that genuinely need it; treat all data-channel input as untrusted user content, never as a system prompt.",
			Control:    "Role templates default subscribers to canPublishData=false; the grant linter flags a listener with data-channel publish as a prompt-injection surface.",
		},
		{
			ID:         "TM-2",
			Threat:     "Egress / recording exposure",
			Vector:     "A token or room config carries cloud storage credentials, or recording is enabled without authorization, leaking media to attacker-controlled storage.",
			Mitigation: "Never embed storage secrets in client tokens; gate egress behind a server-side, admin-only path.",
			Control:    "Tokens carry only a VideoGrant (no egress/storage credentials); the upstream library refuses sensitive credentials in client tokens unless explicitly allowed server-side.",
		},
		{
			ID:         "TM-3",
			Threat:     "SFU / signaling trust abuse",
			Vector:     "A forged or tampered token is accepted by the media/signaling server, granting an attacker join, publish, or admin rights.",
			Mitigation: "Verify every token's HS256 signature against the server secret; never trust the payload without a valid signature; reject alg=none.",
			Control:    "Verify uses the upstream signature verifier; the adversary suite proves forged-signature, alg=none, and payload-tamper tokens are all rejected.",
		},
		{
			ID:         "TM-4",
			Threat:     "Cross-room replay",
			Vector:     "A valid token issued for one room is replayed to join a different room the holder was never authorized for.",
			Mitigation: "Bind every token to a single room scope and re-assert that scope at verify time; refuse scope-less tokens for room-scoped checks.",
			Control:    "Mint always sets a room; Verify rejects a room mismatch and refuses an empty room scope; the adversary suite covers cross-room replay.",
		},
		{
			ID:         "TM-5",
			Threat:     "Capability escalation",
			Vector:     "An attacker edits the grant payload (e.g. flips canPublish or roomAdmin) to gain privileges beyond what was issued.",
			Mitigation: "Bind capabilities into the signed claims so any payload edit invalidates the signature; verify required capability server-side.",
			Control:    "Capabilities live in the signed VideoGrant; the adversary suite flips canPublish/roomAdmin and confirms the tamper breaks verification.",
		},
		{
			ID:         "TM-6",
			Threat:     "Long-lived / stolen token replay",
			Vector:     "A leaked token with a long or absent TTL remains usable for an extended window.",
			Mitigation: "Issue short, explicit TTLs; clamp requested lifetimes to a policy ceiling; prefer minting per-session.",
			Control:    "Mint clamps TTL to [1m, 12h] with a 1h default; the grant linter flags missing or over-long TTLs.",
		},
		{
			ID:         "TM-7",
			Threat:     "Join-flood / connection DoS",
			Vector:     "An attacker rapidly joins or churns connections to exhaust SFU capacity and degrade real-time media for legitimate users.",
			Mitigation: "Rate-limit joins per identity/room at the edge; cap room participant counts; require a fresh, short-TTL token per join.",
			Control:    "Per-room, short-TTL, role-scoped tokens make each join individually authorized and revocable by expiry; rate limiting is enforced at the signaling tier (out of scope for the token service).",
		},
		{
			ID:         "TM-8",
			Threat:     "Token-mint abuse",
			Vector:     "An attacker who reaches the mint endpoint requests over-broad grants or floods minting to manufacture credentials at scale.",
			Mitigation: "Restrict minting to vetted role templates; rate-limit the mint endpoint; never accept a raw capability set from an untrusted caller.",
			Control:    "Mint accepts only a role template (publisher/subscriber/admin) and a room — not arbitrary capabilities — so a caller cannot mint a grant the template does not permit.",
		},
	}
}
