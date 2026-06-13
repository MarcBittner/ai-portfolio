package llm

import (
	"context"
	"os"
	"testing"
)

func TestOfflineIsTerminal(t *testing.T) {
	// Clear every provider key so the chain has nothing to route to.
	for _, k := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"} {
		t.Setenv(k, "")
	}
	// Point Ollama at an unreachable host so the probe fails fast.
	t.Setenv("OLLAMA_BASE_URL", "http://127.0.0.1:0")

	called := false
	offline := func(system, user string) string {
		called = true
		return "deterministic-answer"
	}
	res := Complete(context.Background(), "sys", "usr", offline, Options{})
	if !called {
		t.Fatal("offline function was not invoked")
	}
	if res.Provider != "offline" || res.Model != "deterministic" {
		t.Errorf("expected offline/deterministic, got %s/%s", res.Provider, res.Model)
	}
	if res.Text != "deterministic-answer" {
		t.Errorf("text = %q", res.Text)
	}
	if res.CostUSD != 0 {
		t.Errorf("offline cost should be 0, got %v", res.CostUSD)
	}
}

func TestResolveModeDefaults(t *testing.T) {
	t.Setenv("LLM_MODE", "")
	if got := ResolveMode(""); got != ModeAuto {
		t.Errorf("default mode = %q, want auto", got)
	}
	if got := ResolveMode(ModeFree); got != ModeFree {
		t.Errorf("explicit mode = %q, want free", got)
	}
	t.Setenv("LLM_MODE", "local")
	if got := ResolveMode(""); got != ModeLocal {
		t.Errorf("env mode = %q, want local", got)
	}
}

func TestStatusReportsProviders(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	st := Status()
	providers, ok := st["providers"].(map[string]bool)
	if !ok {
		t.Fatalf("providers missing or wrong type: %T", st["providers"])
	}
	if providers["anthropic"] {
		t.Error("anthropic should be unavailable with no key")
	}
	if st["offline_fallback"] != true {
		t.Error("offline_fallback should always be true")
	}
}

func TestOfflineModePinSkipsProviders(t *testing.T) {
	// Even if a key were set, mode=offline must go straight to the offline func.
	t.Setenv("ANTHROPIC_API_KEY", "sk-fake")
	defer os.Unsetenv("ANTHROPIC_API_KEY")
	res := Complete(context.Background(), "s", "u",
		func(string, string) string { return "x" }, Options{Mode: ModeOffline})
	if res.Provider != "offline" {
		t.Errorf("offline mode must not call a provider, got %q", res.Provider)
	}
}
