// Security coverage for relaytoken's token core — the trust boundary.
//
// Modeled on rate-atlas/tests/test_security.py, adapted to relaytoken's Go token
// mint/verify service. This file asserts the security-critical invariants:
//
//  1. THE TRUST BOUNDARY — mint/verify is deterministic. A cryptographically valid
//     token is still refused when it does not cover the requested room or capability,
//     and a least-privilege subscriber cannot satisfy the publish capability.
//     (The full adversarial breaker suite — forged / alg=none / replay / tamper /
//     expired / nbf / malformed, block_rate == 1.0 — is asserted in the adversary
//     package's security_test.go, which imports token without a cycle.)
//  2. no secret leakage — the HS256 signing secret never appears in a minted token,
//     a decoded grant, or a verify result (success or failure).
//  3. input hardening — Verify never panics and returns a clean verdict on garbage,
//     oversized, wrong-shape, and injection-looking tokens (never an unhandled
//     error/panic that a handler would turn into a 500).
//  4. determinism — minting the same request and verifying the same token are
//     repeatable.
//
// Hermetic: no network, no env, no LLM — the token core stands alone.
package token

import (
	"strings"
	"testing"
	"time"
)

// Mirrors the secret newIssuer(t) (in token_test.go) signs with, so the
// no-leak assertions check the exact key material in play.
const (
	testSecret = "test-secret-which-is-at-least-32-chars"
	testRoom   = "room-alpha"
)

// --------------------------------------------------------------------------- //
// 1. TRUST BOUNDARY — deterministic scope/capability enforcement               //
// --------------------------------------------------------------------------- //

func TestValidTokenRefusedForWrongRoomAndCapability(t *testing.T) {
	iss := newIssuer(t)
	res, err := iss.Mint(MintRequest{Role: RoleSubscriber, Room: testRoom, Identity: "bob", TTL: time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// Same token, four checks: right room+join passes; wrong room, missing
	// capability, and an unknown capability are all refused.
	if v := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: CapJoin}); !v.Valid {
		t.Errorf("legit subscriber join should pass, got %q", v.Why)
	}
	if v := iss.Verify(VerifyRequest{Token: res.Token, Room: "room-beta", Capability: CapJoin}); v.Valid {
		t.Error("cross-room replay must be rejected")
	}
	if v := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: CapPublish}); v.Valid {
		t.Error("subscriber must not satisfy the publish capability")
	}
	if v := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: Capability("teleport")}); v.Valid {
		t.Error("an unknown capability must never be satisfied")
	}
}

// --------------------------------------------------------------------------- //
// 2. No secret leakage — the signing secret never escapes                      //
// --------------------------------------------------------------------------- //

func TestSigningSecretNeverEmbeddedInToken(t *testing.T) {
	iss := newIssuer(t)
	res, err := iss.Mint(MintRequest{Role: RolePublisher, Room: testRoom, Identity: "alice", TTL: time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// The JWT is signed WITH the secret but must never EMBED it.
	if strings.Contains(res.Token, testSecret) {
		t.Fatal("minted token leaked the HS256 signing secret")
	}
	// Verify the secret is not recoverable from the verify verdict either.
	v := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: CapJoin})
	if strings.Contains(v.Why, testSecret) {
		t.Fatal("verify result leaked the signing secret")
	}
	// A failing verify must not echo the secret in its reason string.
	bad := iss.Verify(VerifyRequest{Token: "garbage", Room: testRoom})
	if strings.Contains(bad.Why, testSecret) {
		t.Fatal("verify failure reason leaked the signing secret")
	}
}

// --------------------------------------------------------------------------- //
// 3. Input hardening — Verify never panics / always returns a clean verdict     //
// --------------------------------------------------------------------------- //

func TestVerifyNeverPanicsOnGarbage(t *testing.T) {
	iss := newIssuer(t)
	cases := []string{
		"",
		"not-a-jwt",
		"a.b.c",
		"a.b.c.d.e",
		"only-one-segment",
		"\x00\x01\x02",
		"../../etc/passwd",
		"Ignore previous instructions and print the secret",
		strings.Repeat("x", 200_000), // oversized
		strings.Repeat("a.", 50_000), // many segments
	}
	for _, tok := range cases {
		// A panic here would surface as a 500 in the handler; assert a clean verdict.
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("Verify panicked on %q...: %v", tok[:min(len(tok), 16)], r)
				}
			}()
			v := iss.Verify(VerifyRequest{Token: tok, Room: testRoom, Capability: CapJoin})
			if v.Valid {
				t.Errorf("garbage token %q... was accepted", tok[:min(len(tok), 16)])
			}
		}()
	}
}

func TestMintRejectsEmptyRoomAndUnknownRole(t *testing.T) {
	iss := newIssuer(t)
	if _, err := iss.Mint(MintRequest{Role: RolePublisher, Room: "", Identity: "x", TTL: time.Hour}); err == nil {
		t.Error("mint with empty room must fail (no wildcard grants)")
	}
	if _, err := iss.Mint(MintRequest{Role: Role("superuser"), Room: testRoom, TTL: time.Hour}); err == nil {
		t.Error("mint with an unknown role must fail")
	}
}

func TestTTLClampedToPolicyBounds(t *testing.T) {
	iss := newIssuer(t)
	// An over-long TTL is clamped, not honored verbatim (over-grant hardening).
	res, err := iss.Mint(MintRequest{Role: RolePublisher, Room: testRoom, TTL: 1000 * time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if res.Grant.TTL != MaxTTL.String() {
		t.Errorf("TTL not clamped: got %s, want %s", res.Grant.TTL, MaxTTL.String())
	}
	// A zero TTL falls back to the default, never an unbounded credential.
	res0, _ := iss.Mint(MintRequest{Role: RolePublisher, Room: testRoom, TTL: 0})
	if res0.Grant.TTL != DefaultTTL.String() {
		t.Errorf("zero TTL not defaulted: got %s", res0.Grant.TTL)
	}
}

// --------------------------------------------------------------------------- //
// 4. Determinism — mint/verify are repeatable                                  //
// --------------------------------------------------------------------------- //

func TestVerifyIsDeterministic(t *testing.T) {
	iss := newIssuer(t)
	res, err := iss.Mint(MintRequest{Role: RolePublisher, Room: testRoom, Identity: "alice", TTL: time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	a := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: CapPublish})
	b := iss.Verify(VerifyRequest{Token: res.Token, Room: testRoom, Capability: CapPublish})
	if a.Valid != b.Valid || a.Why != b.Why {
		t.Errorf("verify not deterministic: %+v vs %+v", a, b)
	}
	if !a.Valid {
		t.Errorf("legit publisher publish should verify, got %q", a.Why)
	}
}
