// Package adversary is the "breaker" half of the demo: a deterministic attack
// harness that mints a legitimate token and then attempts a battery of token
// abuses against the verifier, asserting each is REJECTED. The headline metric is
// block_rate — the fraction of attacks the verifier refused. A correct token
// model scores 1.0 (8/8 blocked).
//
// The harness uses only the public verify path (token.Issuer.Verify), so it
// proves the property an attacker actually faces, not an internal shortcut.
package adversary

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"

	"relaytoken/internal/token"
)

// Case is one attack and its outcome.
type Case struct {
	Name     string `json:"name"`
	Attack   string `json:"attack"`   // what the adversary did
	Expected string `json:"expected"` // the security property
	Blocked  bool   `json:"blocked"`  // true == verifier rejected it (good)
	Detail   string `json:"detail"`   // the verifier's reason
}

// Report is the full suite plus the aggregate block rate.
type Report struct {
	Cases     []Case  `json:"cases"`
	Total     int     `json:"total"`
	Blocked   int     `json:"blocked"`
	BlockRate float64 `json:"block_rate"`
}

const (
	apiKey = "relaytoken-demo-key"
	secret = "relaytoken-demo-secret-which-is-32+chars-long"
	room   = "room-alpha"
)

// b64url encodes without padding, as JWT segments require.
func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// Run executes the full breaker suite against a fresh issuer/verifier.
func Run() Report {
	iss, err := token.NewIssuer(apiKey, secret)
	if err != nil {
		// Misconfiguration is itself a hard failure; surface it as an unblocked case.
		return Report{Cases: []Case{{Name: "setup", Detail: err.Error()}}, Total: 1}
	}

	// A legitimate publisher token, scoped to room-alpha, valid for an hour.
	good, err := iss.Mint(token.MintRequest{
		Role: token.RolePublisher, Room: room, Identity: "alice", TTL: time.Hour,
	})
	if err != nil {
		return Report{Cases: []Case{{Name: "setup", Detail: err.Error()}}, Total: 1}
	}

	// verifyBlocked runs a verify and treats a non-valid result as "blocked".
	check := func(name, attack, expected string, vr token.VerifyResult) Case {
		return Case{
			Name: name, Attack: attack, Expected: expected,
			Blocked: !vr.Valid, Detail: vr.Why,
		}
	}

	var cases []Case

	// 1. Forged signature — re-sign the legit token with the attacker's secret.
	forged := resignWithSecret(good.Token, "attacker-secret-not-the-real-one")
	cases = append(cases, check(
		"forged_signature",
		"re-signed a valid token with an attacker-controlled HS256 secret",
		"reject: HMAC does not verify under the server secret",
		iss.Verify(token.VerifyRequest{Token: forged, Room: room, Capability: token.CapJoin}),
	))

	// 2. alg=none downgrade — strip the signature and set the header alg to "none".
	none := algNoneDowngrade(good.Token)
	cases = append(cases, check(
		"alg_none_downgrade",
		"set JWT header alg=none and dropped the signature",
		"reject: verifier requires a real HS256 signature, never alg=none",
		iss.Verify(token.VerifyRequest{Token: none, Room: room, Capability: token.CapJoin}),
	))

	// 3. Expired — a properly signed token whose TTL already elapsed.
	expired := mintExpired(iss, -1*time.Hour)
	cases = append(cases, check(
		"expired",
		"presented a correctly signed token whose expiry is in the past",
		"reject: token past its exp claim",
		iss.Verify(token.VerifyRequest{Token: expired, Room: room, Capability: token.CapJoin}),
	))

	// 4. Not-yet-valid (nbf) — a signed token whose not-before is in the future.
	notYet := mintNotYetValid(2 * time.Hour)
	cases = append(cases, check(
		"not_yet_valid_nbf",
		"presented a signed token whose not-before (nbf) is in the future",
		"reject: token not yet valid",
		iss.Verify(token.VerifyRequest{Token: notYet, Room: room, Capability: token.CapJoin}),
	))

	// 5. Cross-room replay — a valid token for room-alpha replayed at room-beta.
	cases = append(cases, check(
		"cross_room_replay",
		"replayed a valid room-alpha token against a different room (room-beta)",
		"reject: room scope mismatch",
		iss.Verify(token.VerifyRequest{Token: good.Token, Room: "room-beta", Capability: token.CapJoin}),
	))

	// 6. Capability escalation — flip canPublish in the payload, keep the sig.
	escalated := flipCanPublish(good.Token)
	cases = append(cases, check(
		"capability_escalation",
		"edited the grant payload to add a capability while keeping the original signature",
		"reject: payload tamper breaks the signature",
		iss.Verify(token.VerifyRequest{Token: escalated, Room: room, Capability: token.CapAdmin}),
	))

	// 7. Subscriber publishing — a least-privilege subscriber token asked to publish.
	subTok, _ := iss.Mint(token.MintRequest{
		Role: token.RoleSubscriber, Room: room, Identity: "bob", TTL: time.Hour,
	})
	cases = append(cases, check(
		"least_privilege_publish",
		"used a subscriber-only token to claim the publish capability",
		"reject: grant does not include publish",
		iss.Verify(token.VerifyRequest{Token: subTok.Token, Room: room, Capability: token.CapPublish}),
	))

	// 8. Garbage / truncated token — a non-JWT string presented as a token.
	cases = append(cases, check(
		"malformed_token",
		"presented a truncated, non-JWT string as a token",
		"reject: token does not parse",
		iss.Verify(token.VerifyRequest{Token: good.Token[:len(good.Token)/2], Room: room, Capability: token.CapJoin}),
	))

	blocked := 0
	for _, c := range cases {
		if c.Blocked {
			blocked++
		}
	}
	rate := 0.0
	if len(cases) > 0 {
		rate = float64(blocked) / float64(len(cases))
	}
	return Report{Cases: cases, Total: len(cases), Blocked: blocked, BlockRate: rate}
}

// --------------------------------------------------------------------------- //
// Attack constructions (deterministic JWT surgery)                            //
// --------------------------------------------------------------------------- //

// splitJWT returns the three dot-separated segments, or false if not three.
func splitJWT(tok string) (header, payload, sig string, ok bool) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

// resignWithSecret re-signs the header.payload with a different HS256 secret.
func resignWithSecret(tok, badSecret string) string {
	h, p, _, ok := splitJWT(tok)
	if !ok {
		return tok + ".forged"
	}
	signing := h + "." + p
	mac := hmac.New(sha256.New, []byte(badSecret))
	mac.Write([]byte(signing))
	return signing + "." + b64url(mac.Sum(nil))
}

// algNoneDowngrade rewrites the header to {"alg":"none","typ":"JWT"} and drops
// the signature — the classic JWT downgrade attack.
func algNoneDowngrade(tok string) string {
	_, p, _, ok := splitJWT(tok)
	if !ok {
		return tok
	}
	newHeader := b64url([]byte(`{"alg":"none","typ":"JWT"}`))
	return newHeader + "." + p + "."
}

// flipCanPublish decodes the payload, forces canPublish=true (privilege bump),
// re-encodes it, but leaves the ORIGINAL signature in place — so the tamper must
// be caught by signature verification, not by trusting the payload.
func flipCanPublish(tok string) string {
	h, p, s, ok := splitJWT(tok)
	if !ok {
		return tok
	}
	raw, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return tok
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return tok
	}
	video, _ := claims["video"].(map[string]any)
	if video == nil {
		video = map[string]any{}
	}
	video["canPublish"] = true
	video["roomAdmin"] = true
	claims["video"] = video
	tampered, _ := json.Marshal(claims)
	return h + "." + b64url(tampered) + "." + s
}

// mintExpired signs a real token whose TTL is already in the past by building it
// with a negative validity window on the upstream access token.
func mintExpired(iss *token.Issuer, age time.Duration) string {
	// The upstream AccessToken always stamps nbf=now/exp=now+ttl, so to forge an
	// already-expired token we sign one directly with go-jose-style claims.
	return signClaims(map[string]any{
		"iss":   apiKey,
		"sub":   "alice",
		"nbf":   time.Now().Add(age - time.Hour).Unix(),
		"exp":   time.Now().Add(age).Unix(),
		"video": publisherVideo(),
	})
}

// mintNotYetValid signs a token whose nbf is in the future.
func mintNotYetValid(delay time.Duration) string {
	return signClaims(map[string]any{
		"iss":   apiKey,
		"sub":   "alice",
		"nbf":   time.Now().Add(delay).Unix(),
		"exp":   time.Now().Add(delay + time.Hour).Unix(),
		"video": publisherVideo(),
	})
}

func publisherVideo() map[string]any {
	return map[string]any{
		"roomJoin": true, "room": room,
		"canPublish": true, "canSubscribe": true, "canPublishData": true,
	}
}

// signClaims signs an arbitrary claim set with the REAL server secret (HS256),
// so the only reason verification fails is the temporal claim — proving expiry
// and nbf are enforced independently of the signature.
func signClaims(claims map[string]any) string {
	header := b64url([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	payload := b64url(body)
	signing := header + "." + payload
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	return signing + "." + b64url(mac.Sum(nil))
}

// compile-time use of auth to keep the dependency edge explicit in this package.
var _ = auth.NewAccessToken
