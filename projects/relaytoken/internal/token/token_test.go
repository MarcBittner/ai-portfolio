package token

import (
	"strings"
	"testing"
	"time"
)

func newIssuer(t *testing.T) *Issuer {
	t.Helper()
	iss, err := NewIssuer("test-key", "test-secret-which-is-at-least-32-chars")
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}
	return iss
}

func TestMintPublisherGrant(t *testing.T) {
	iss := newIssuer(t)
	res, err := iss.Mint(MintRequest{Role: RolePublisher, Room: "r1", Identity: "alice", TTL: time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if !res.Grant.CanPublish || !res.Grant.CanSubscribe || !res.Grant.CanPublishData {
		t.Errorf("publisher should publish+subscribe+data, got %+v", res.Grant)
	}
	if res.Grant.RoomAdmin {
		t.Error("publisher must not be room admin")
	}
	if res.Grant.Room != "r1" {
		t.Errorf("room = %q, want r1", res.Grant.Room)
	}
	if !strings.Contains(res.Token, ".") {
		t.Error("token does not look like a JWT")
	}
}

func TestMintSubscriberIsLeastPrivilege(t *testing.T) {
	iss := newIssuer(t)
	res, err := iss.Mint(MintRequest{Role: RoleSubscriber, Room: "r1", TTL: time.Hour})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if res.Grant.CanPublish {
		t.Error("subscriber must not be able to publish")
	}
	if res.Grant.CanPublishData {
		t.Error("subscriber must not publish data (prompt-injection surface)")
	}
	if !res.Grant.CanSubscribe {
		t.Error("subscriber must be able to subscribe")
	}
}

func TestMintUnknownRoleAndEmptyRoom(t *testing.T) {
	iss := newIssuer(t)
	if _, err := iss.Mint(MintRequest{Role: "superuser", Room: "r1"}); err == nil {
		t.Error("unknown role should error")
	}
	if _, err := iss.Mint(MintRequest{Role: RolePublisher, Room: ""}); err == nil {
		t.Error("empty room should error")
	}
}

func TestTTLClamping(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want time.Duration
	}{
		{0, DefaultTTL},
		{30 * time.Second, MinTTL},
		{24 * time.Hour, MaxTTL},
		{2 * time.Hour, 2 * time.Hour},
	}
	for _, c := range cases {
		if got := clampTTL(c.in); got != c.want {
			t.Errorf("clampTTL(%s) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestVerifyHappyPath(t *testing.T) {
	iss := newIssuer(t)
	res, _ := iss.Mint(MintRequest{Role: RolePublisher, Room: "r1", Identity: "alice", TTL: time.Hour})
	vr := iss.Verify(VerifyRequest{Token: res.Token, Room: "r1", Capability: CapPublish})
	if !vr.Valid {
		t.Fatalf("expected valid, got why=%q", vr.Why)
	}
	if vr.Grant == nil || vr.Grant.Identity != "alice" {
		t.Errorf("grant identity not propagated: %+v", vr.Grant)
	}
}

func TestVerifyCrossRoomRejected(t *testing.T) {
	iss := newIssuer(t)
	res, _ := iss.Mint(MintRequest{Role: RolePublisher, Room: "r1", TTL: time.Hour})
	vr := iss.Verify(VerifyRequest{Token: res.Token, Room: "r2", Capability: CapJoin})
	if vr.Valid {
		t.Error("token for r1 must not verify against r2")
	}
}

func TestVerifyCapabilityNotGranted(t *testing.T) {
	iss := newIssuer(t)
	res, _ := iss.Mint(MintRequest{Role: RoleSubscriber, Room: "r1", TTL: time.Hour})
	vr := iss.Verify(VerifyRequest{Token: res.Token, Room: "r1", Capability: CapPublish})
	if vr.Valid {
		t.Error("subscriber token must not satisfy a publish requirement")
	}
}

func TestVerifyWrongSecretRejected(t *testing.T) {
	iss := newIssuer(t)
	res, _ := iss.Mint(MintRequest{Role: RolePublisher, Room: "r1", TTL: time.Hour})
	other, _ := NewIssuer("test-key", "a-totally-different-secret-32-chars!!")
	vr := other.Verify(VerifyRequest{Token: res.Token, Room: "r1", Capability: CapJoin})
	if vr.Valid {
		t.Error("token must not verify under a different secret")
	}
}

func TestVerifyMalformed(t *testing.T) {
	iss := newIssuer(t)
	if iss.Verify(VerifyRequest{Token: "", Room: "r1"}).Valid {
		t.Error("empty token must be invalid")
	}
	if iss.Verify(VerifyRequest{Token: "not.a.jwt", Room: "r1"}).Valid {
		t.Error("garbage token must be invalid")
	}
}

func TestNewIssuerRequiresKeys(t *testing.T) {
	if _, err := NewIssuer("", "s"); err == nil {
		t.Error("empty key should error")
	}
	if _, err := NewIssuer("k", ""); err == nil {
		t.Error("empty secret should error")
	}
}
