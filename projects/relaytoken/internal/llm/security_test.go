// Security coverage for the LLM router: no key material ever surfaces in Status,
// and offline mode is a hermetic terminal fallback even with keys planted.
//
// Complements llm_test.go (offline-terminal, offline-pin, status shape) with the
// secret-leakage invariant: planting credential-shaped sentinels into the provider
// env vars, Status() reports only booleans and never echoes a key value.
package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const (
	sentinelAnthropic = "sk-ant-LEAKCANARY0001"
	sentinelOpenAI    = "sk-LEAKCANARY0002"
	sentinelOpenRtr   = "sk-or-LEAKCANARY0003"
)

func plantKeys(t *testing.T) {
	t.Helper()
	t.Setenv("ANTHROPIC_API_KEY", sentinelAnthropic)
	t.Setenv("OPENAI_API_KEY", sentinelOpenAI)
	t.Setenv("OPENROUTER_API_KEY", sentinelOpenRtr)
	t.Setenv("OLLAMA_BASE_URL", "http://127.0.0.1:1") // unreachable
}

func TestStatusReportsBooleansNeverKeyMaterial(t *testing.T) {
	plantKeys(t)
	st := Status()
	providers, ok := st["providers"].(map[string]bool)
	if !ok {
		t.Fatalf("providers wrong type: %T", st["providers"])
	}
	// Availability is reported as a bool; with a key set, true is fine — the point
	// is the boolean, not the key.
	for name, avail := range providers {
		_ = name
		_ = avail // value is a bool by the type assertion above
	}
	// Serialize the whole status payload and assert no sentinel key value leaks.
	blob, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	for _, secret := range []string{sentinelAnthropic, sentinelOpenAI, sentinelOpenRtr} {
		if strings.Contains(string(blob), secret) {
			t.Fatalf("Status() leaked a provider key value: %q", secret)
		}
	}
}

func TestOfflineModeIsHermeticWithKeysPlanted(t *testing.T) {
	plantKeys(t)
	// Even with every key present, mode=offline must go straight to the offline
	// func with zero cost and never contact a provider (no network egress).
	res := Complete(context.Background(), "sys", "usr",
		func(string, string) string { return "deterministic" },
		Options{Mode: ModeOffline})
	if res.Provider != "offline" {
		t.Fatalf("offline mode must not call a provider, got %q", res.Provider)
	}
	if res.CostUSD != 0 {
		t.Errorf("offline cost should be 0, got %v", res.CostUSD)
	}
	for _, secret := range []string{sentinelAnthropic, sentinelOpenAI, sentinelOpenRtr} {
		if strings.Contains(res.Text, secret) {
			t.Fatalf("offline result leaked a provider key value: %q", secret)
		}
	}
}
