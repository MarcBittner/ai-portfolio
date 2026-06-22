// Security coverage for the adversarial breaker suite — the headline trust
// boundary for relaytoken. Complements adversary_test.go by naming each headline
// attack and re-asserting the perfect block rate, so a regression points at the
// exact defense that broke (forged / alg=none / replay / tamper / expired / nbf /
// least-privilege / malformed), not just the aggregate.
package adversary

import "testing"

func TestBlockRateIsOneAndEveryNamedAttackIsBlocked(t *testing.T) {
	rep := Run()
	if rep.Total < 8 {
		t.Fatalf("expected >= 8 adversary cases, got %d", rep.Total)
	}
	if rep.BlockRate != 1.0 {
		t.Fatalf("block_rate = %v, want 1.0 (%d/%d blocked)", rep.BlockRate, rep.Blocked, rep.Total)
	}

	want := []string{
		"forged_signature",
		"alg_none_downgrade",
		"expired",
		"not_yet_valid_nbf",
		"cross_room_replay",
		"capability_escalation",
		"least_privilege_publish",
		"malformed_token",
	}
	got := map[string]bool{}
	for _, c := range rep.Cases {
		got[c.Name] = c.Blocked
	}
	for _, name := range want {
		blocked, present := got[name]
		if !present {
			t.Errorf("adversary case %q is missing from the suite", name)
			continue
		}
		if !blocked {
			t.Errorf("attack %q was NOT blocked (LEAK)", name)
		}
	}
}
