package grant

import (
	"context"
	"strings"
	"testing"
)

func TestLintFlagsOverGrantedSubscriber(t *testing.T) {
	lr := Lint(Proposal{
		Role: "subscriber", Room: "", CanPublish: true, CanSubscribe: true,
		CanPublishData: true, TTLSeconds: 24 * 3600,
	})
	if lr.LeastPriv {
		t.Fatal("an over-permissioned subscriber must not be reported least-priv")
	}
	codes := map[string]bool{}
	for _, f := range lr.Findings {
		codes[f.Code] = true
	}
	for _, want := range []string{"no_room_scope", "subscriber_can_publish", "over_long_ttl"} {
		if !codes[want] {
			t.Errorf("expected finding %q, findings=%v", want, codes)
		}
	}
	if lr.RiskScore == 0 {
		t.Error("risk score should be > 0 for an over-grant")
	}
}

func TestLintCleanSubscriberIsLeastPriv(t *testing.T) {
	lr := Lint(Proposal{
		Role: "subscriber", Room: "room-alpha", CanSubscribe: true, TTLSeconds: 3600,
	})
	if !lr.LeastPriv {
		t.Errorf("a scoped subscriber should be least-priv, findings=%+v", lr.Findings)
	}
	if lr.RiskScore != 0 {
		t.Errorf("risk = %d, want 0", lr.RiskScore)
	}
}

func TestLintFlagsMissingTTL(t *testing.T) {
	lr := Lint(Proposal{Role: "publisher", Room: "r1", CanPublish: true, CanSubscribe: true, TTLSeconds: 0})
	found := false
	for _, f := range lr.Findings {
		if f.Code == "no_ttl" {
			found = true
		}
	}
	if !found {
		t.Error("missing TTL should be flagged")
	}
}

func TestExplainOfflineIsTerminal(t *testing.T) {
	// With no provider keys set, Explain must still return a deterministic
	// explanation via the offline path — never empty, never an error.
	lr := Explain(context.Background(), Proposal{
		Role: "subscriber", Room: "", CanPublish: true, TTLSeconds: 0,
	})
	if lr.Provider != "offline" {
		t.Errorf("with no keys, provider should be offline, got %q", lr.Provider)
	}
	if strings.TrimSpace(lr.Explanation) == "" {
		t.Error("explanation must not be empty")
	}
	if !strings.Contains(lr.Explanation, "over-permissioning") {
		t.Errorf("offline explanation should narrate findings: %q", lr.Explanation)
	}
}
