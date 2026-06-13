package adversary

import "testing"

func TestEveryAttackIsBlocked(t *testing.T) {
	rep := Run()
	if rep.Total < 8 {
		t.Fatalf("expected at least 8 adversary cases, got %d", rep.Total)
	}
	for _, c := range rep.Cases {
		if !c.Blocked {
			t.Errorf("attack %q was NOT blocked (LEAK): %s", c.Name, c.Detail)
		}
	}
}

func TestBlockRateIsPerfect(t *testing.T) {
	rep := Run()
	if rep.BlockRate != 1.0 {
		t.Fatalf("block_rate = %v, want 1.0 (%d/%d blocked)", rep.BlockRate, rep.Blocked, rep.Total)
	}
}

func TestSuiteCoversKeyAttacks(t *testing.T) {
	want := []string{
		"forged_signature", "alg_none_downgrade", "expired", "not_yet_valid_nbf",
		"cross_room_replay", "capability_escalation", "least_privilege_publish",
		"malformed_token",
	}
	have := map[string]bool{}
	for _, c := range Run().Cases {
		have[c.Name] = true
	}
	for _, w := range want {
		if !have[w] {
			t.Errorf("adversary suite missing case %q", w)
		}
	}
}
