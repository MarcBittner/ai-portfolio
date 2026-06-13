// Package llm is a self-contained multi-provider LLM router with a deterministic
// offline fallback. It is the portfolio's standard routing layer, ported to Go
// from the reference llm.py, so every demo carries an identical, reviewable chain:
//
//	paid (Anthropic / OpenAI)  ->  local (Ollama)  ->  free (OpenRouter)  ->  offline
//
// A provider is *available* only when its key is set (or, for Ollama, when a
// probe to /api/tags succeeds), so the chain self-selects from the environment.
// The offline path is a caller-supplied *deterministic* function — the
// last-resort safety net (the service always runs with zero keys and zero cost),
// never the design centre. Complete walks the chain in order, records which
// providers it fell back through, and returns the first success.
//
// No third-party HTTP dependency: requests go through net/http + encoding/json,
// so the package is self-contained and import-safe offline.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Mode pins the router to a tier; "auto" walks the full chain.
type Mode string

const (
	ModeAuto    Mode = "auto"
	ModePaid    Mode = "paid"
	ModeLocal   Mode = "local"
	ModeFree    Mode = "free"
	ModeOffline Mode = "offline"
)

// chain is the provider order within each tier. "auto" is the full standardized chain.
var chain = map[Mode][]string{
	ModeAuto:    {"anthropic", "openai", "ollama", "openrouter"},
	ModePaid:    {"anthropic", "openai"},
	ModeLocal:   {"ollama"},
	ModeFree:    {"openrouter"},
	ModeOffline: {},
}

// price holds indicative blended $/Mtok (input, output). Free + local = 0.
var price = map[string][2]float64{
	"anthropic":  {1.0, 5.0},  // claude-haiku-class
	"openai":     {0.15, 0.6}, // gpt-4o-mini-class
	"openrouter": {0.0, 0.0},  // free models
	"ollama":     {0.0, 0.0},
}

// OfflineFunc is the deterministic, always-terminal fallback: (system, user) -> text.
type OfflineFunc func(system, user string) string

// Result is one completion plus the routing telemetry an interviewer will ask about.
type Result struct {
	Text      string   `json:"text"`
	Provider  string   `json:"provider"` // anthropic | openai | ollama | openrouter | offline
	Model     string   `json:"model"`
	Mode      string   `json:"mode"`
	LatencyMS float64  `json:"latency_ms"`
	CostUSD   float64  `json:"cost_usd"`
	Fallbacks []string `json:"fallbacks"` // providers tried, then skipped
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func defaultModel(provider string) string {
	switch provider {
	case "anthropic":
		return env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
	case "openai":
		return env("OPENAI_MODEL", "gpt-4o-mini")
	case "openrouter":
		return env("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
	case "ollama":
		return env("OLLAMA_MODEL", "llama3.1:8b")
	}
	return ""
}

func ollamaURL() string {
	return strings.TrimRight(env("OLLAMA_BASE_URL", "http://localhost:11434"), "/")
}

// --------------------------------------------------------------------------- //
// Availability                                                                //
// --------------------------------------------------------------------------- //

type probe struct {
	ok bool
	at time.Time
}

var (
	probeMu    sync.Mutex
	probeCache = map[string]probe{}
)

func ollamaReachable() bool {
	probeMu.Lock()
	if p, ok := probeCache["ollama"]; ok && time.Since(p.at) < 30*time.Second {
		probeMu.Unlock()
		return p.ok
	}
	probeMu.Unlock()

	ok := false
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ollamaURL()+"/api/tags", nil)
	if err == nil {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			ok = resp.StatusCode == http.StatusOK
			resp.Body.Close()
		}
	}
	probeMu.Lock()
	probeCache["ollama"] = probe{ok: ok, at: time.Now()}
	probeMu.Unlock()
	return ok
}

func available(provider string) bool {
	switch provider {
	case "anthropic":
		return os.Getenv("ANTHROPIC_API_KEY") != ""
	case "openai":
		return os.Getenv("OPENAI_API_KEY") != ""
	case "openrouter":
		return os.Getenv("OPENROUTER_API_KEY") != ""
	case "ollama":
		return ollamaReachable()
	}
	return false
}

// Status reports which providers are configured/reachable right now.
func Status() map[string]any {
	providers := map[string]bool{}
	for _, p := range []string{"anthropic", "openai", "ollama", "openrouter"} {
		providers[p] = available(p)
	}
	return map[string]any{
		"mode":             string(ResolveMode("")),
		"providers":        providers,
		"offline_fallback": true,
		"ollama_url":       ollamaURL(),
	}
}

// ResolveMode picks the effective mode: explicit arg > $LLM_MODE > auto.
func ResolveMode(m Mode) Mode {
	s := strings.ToLower(string(m))
	if s == "" {
		s = strings.ToLower(env("LLM_MODE", "auto"))
	}
	if s == "" {
		s = "auto"
	}
	return Mode(s)
}

// --------------------------------------------------------------------------- //
// Provider calls                                                              //
// --------------------------------------------------------------------------- //

func post(ctx context.Context, url string, payload any, headers map[string]string, timeout time.Duration) (map[string]any, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("provider %s: status %d", url, resp.StatusCode)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

type callResult struct {
	text     string
	model    string
	inTokens int
	outToken int
}

func call(ctx context.Context, provider, system, user string, jsonMode bool, maxTokens int) (callResult, error) {
	model := defaultModel(provider)
	switch provider {
	case "anthropic":
		out, err := post(ctx, "https://api.anthropic.com/v1/messages", map[string]any{
			"model":      model,
			"max_tokens": maxTokens,
			"system":     system,
			"messages":   []map[string]any{{"role": "user", "content": user}},
		}, map[string]string{
			"x-api-key":         os.Getenv("ANTHROPIC_API_KEY"),
			"anthropic-version": "2023-06-01",
		}, 60*time.Second)
		if err != nil {
			return callResult{}, err
		}
		var text strings.Builder
		if content, ok := out["content"].([]any); ok {
			for _, b := range content {
				if m, ok := b.(map[string]any); ok {
					if t, ok := m["text"].(string); ok {
						text.WriteString(t)
					}
				}
			}
		}
		in, outTok := usageInts(out, "usage", "input_tokens", "output_tokens")
		return callResult{text.String(), model, in, outTok}, nil

	case "openai", "openrouter":
		base := "https://api.openai.com/v1"
		keyVar := "OPENAI_API_KEY"
		if provider == "openrouter" {
			base = "https://openrouter.ai/api/v1"
			keyVar = "OPENROUTER_API_KEY"
		}
		payload := map[string]any{
			"model": model,
			"messages": []map[string]any{
				{"role": "system", "content": system},
				{"role": "user", "content": user},
			},
			"max_tokens": maxTokens,
		}
		if jsonMode {
			payload["response_format"] = map[string]string{"type": "json_object"}
		}
		out, err := post(ctx, base+"/chat/completions", payload, map[string]string{
			"authorization": "Bearer " + os.Getenv(keyVar),
		}, 60*time.Second)
		if err != nil {
			return callResult{}, err
		}
		text := openAIContent(out)
		in, outTok := usageInts(out, "usage", "prompt_tokens", "completion_tokens")
		return callResult{text, model, in, outTok}, nil

	case "ollama":
		payload := map[string]any{
			"model":  model,
			"stream": false,
			"messages": []map[string]any{
				{"role": "system", "content": system},
				{"role": "user", "content": user},
			},
		}
		if jsonMode {
			payload["format"] = "json"
		}
		out, err := post(ctx, ollamaURL()+"/api/chat", payload, nil, 120*time.Second)
		if err != nil {
			return callResult{}, err
		}
		text := ""
		if msg, ok := out["message"].(map[string]any); ok {
			if c, ok := msg["content"].(string); ok {
				text = c
			}
		}
		in, outTok := topInts(out, "prompt_eval_count", "eval_count")
		return callResult{text, model, in, outTok}, nil
	}
	return callResult{}, fmt.Errorf("unknown provider %q", provider)
}

func openAIContent(out map[string]any) string {
	choices, ok := out["choices"].([]any)
	if !ok || len(choices) == 0 {
		return ""
	}
	c, ok := choices[0].(map[string]any)
	if !ok {
		return ""
	}
	msg, ok := c["message"].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := msg["content"].(string)
	return s
}

func usageInts(out map[string]any, usageKey, inKey, outKey string) (int, int) {
	u, ok := out[usageKey].(map[string]any)
	if !ok {
		return 0, 0
	}
	return asInt(u[inKey]), asInt(u[outKey])
}

func topInts(out map[string]any, inKey, outKey string) (int, int) {
	return asInt(out[inKey]), asInt(out[outKey])
}

func asInt(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

// --------------------------------------------------------------------------- //
// Router                                                                      //
// --------------------------------------------------------------------------- //

// Options tunes a single Complete call.
type Options struct {
	Mode      Mode
	JSONMode  bool
	MaxTokens int
}

// Complete runs the routing chain and returns the first success. offline is the
// deterministic last-resort function; it is always terminal, so Complete never
// fails for lack of a provider.
func Complete(ctx context.Context, system, user string, offline OfflineFunc, opts Options) Result {
	resolved := ResolveMode(opts.Mode)
	maxTokens := opts.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 1024
	}
	providers, ok := chain[resolved]
	if !ok {
		providers = chain[ModeAuto]
	}
	var fallbacks []string
	for _, provider := range providers {
		if !available(provider) {
			continue
		}
		t0 := time.Now()
		res, err := call(ctx, provider, system, user, opts.JSONMode, maxTokens)
		if err != nil || strings.TrimSpace(res.text) == "" {
			fallbacks = append(fallbacks, provider)
			continue
		}
		p := price[provider]
		return Result{
			Text:      res.text,
			Provider:  provider,
			Model:     res.model,
			Mode:      string(resolved),
			LatencyMS: msSince(t0),
			CostUSD:   round6((float64(res.inTokens)*p[0] + float64(res.outToken)*p[1]) / 1_000_000),
			Fallbacks: fallbacks,
		}
	}
	t0 := time.Now()
	text := offline(system, user)
	return Result{
		Text:      text,
		Provider:  "offline",
		Model:     "deterministic",
		Mode:      string(resolved),
		LatencyMS: msSince(t0),
		CostUSD:   0.0,
		Fallbacks: fallbacks,
	}
}

func msSince(t0 time.Time) float64 {
	return round1(float64(time.Since(t0).Microseconds()) / 1000.0)
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
func round6(f float64) float64 { return float64(int64(f*1e6+0.5)) / 1e6 }
