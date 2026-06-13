// Command relaytoken is an HTTP service that issues and verifies scoped real-time
// room access tokens on the open-source livekit/protocol auth package, runs an
// adversarial breaker suite against its own token model, serves a static WebRTC /
// realtime-AI threat model, and exposes an LLM-backed grant risk explainer.
//
// It runs fully offline with zero keys: the LLM chain degrades to a deterministic
// explainer, and the security core (mint / verify / adversary) never depends on a
// network call.
//
//	./relaytoken            # serve on $PORT (default 8080)
//	./relaytoken demo       # offline end-to-end walkthrough, then exit
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"relaytoken/internal/adversary"
	"relaytoken/internal/grant"
	"relaytoken/internal/llm"
	"relaytoken/internal/threatmodel"
	"relaytoken/internal/token"
)

const (
	defaultAPIKey = "relaytoken-demo-key"
	// defaultSecret is a non-secret demo signing key; a real deployment supplies
	// RELAYTOKEN_API_SECRET. It is intentionally long enough for HS256.
	defaultSecret = "relaytoken-demo-secret-which-is-32+chars-long"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "demo":
			runDemo()
			return
		case "healthcheck":
			// Used by the container HEALTHCHECK (distroless has no shell/curl).
			os.Exit(healthcheck(env("PORT", "8080")))
		}
	}

	port := env("PORT", "8080")
	iss, err := token.NewIssuer(
		env("RELAYTOKEN_API_KEY", defaultAPIKey),
		env("RELAYTOKEN_API_SECRET", defaultSecret),
	)
	if err != nil {
		log.Fatalf("issuer: %v", err)
	}

	srv := &server{iss: iss}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", srv.healthz)
	mux.HandleFunc("/llm", srv.llmStatus)
	mux.HandleFunc("/token/mint", srv.mint)
	mux.HandleFunc("/token/verify", srv.verify)
	mux.HandleFunc("/adversary", srv.adversary)
	mux.HandleFunc("/threat-model", srv.threatModel)
	mux.HandleFunc("/grant/lint", srv.grantLint)

	addr := ":" + port
	log.Printf("relaytoken listening on %s", addr)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Fatal(httpSrv.ListenAndServe())
}

// healthcheck probes the local /healthz and returns a process exit code, for the
// container HEALTHCHECK on a shell-less distroless image.
func healthcheck(port string) int {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/healthz", nil)
	if err != nil {
		return 1
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

type server struct{ iss *token.Issuer }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func (s *server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "ok",
		"service":    "relaytoken",
		"token_core": "livekit/protocol auth",
		"roles":      token.Roles(),
	})
}

func (s *server) llmStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, llm.Status())
}

// mintRequest is the wire shape; ttl is seconds for JSON friendliness.
type mintRequest struct {
	Role       string `json:"role"`
	Room       string `json:"room"`
	Identity   string `json:"identity"`
	TTLSeconds int    `json:"ttl_seconds"`
}

func (s *server) mint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var req mintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	res, err := s.iss.Mint(token.MintRequest{
		Role:     token.Role(req.Role),
		Room:     req.Room,
		Identity: req.Identity,
		TTL:      time.Duration(req.TTLSeconds) * time.Second,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *server) verify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var req token.VerifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	res := s.iss.Verify(req)
	status := http.StatusOK
	if !res.Valid {
		status = http.StatusUnauthorized
	}
	writeJSON(w, status, res)
}

func (s *server) adversary(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, adversary.Run())
}

func (s *server) threatModel(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"threat_model": threatmodel.Model()})
}

func (s *server) grantLint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var p grant.Proposal
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, grant.Explain(ctx, p))
}

// --------------------------------------------------------------------------- //
// Offline demo CLI                                                            //
// --------------------------------------------------------------------------- //

func runDemo() {
	line := func(s string) { fmt.Println(s) }
	rule := func() { line("--------------------------------------------------------------") }

	iss, err := token.NewIssuer(defaultAPIKey, defaultSecret)
	if err != nil {
		log.Fatal(err)
	}

	line("relaytoken — offline demo (mint -> verify -> adversary -> grant lint -> threat model)")
	rule()

	// 1. Mint
	line("1) MINT a publisher token for room-alpha (ttl 1h)")
	mr, err := iss.Mint(token.MintRequest{Role: token.RolePublisher, Room: "room-alpha", Identity: "alice", TTL: time.Hour})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("   token: %s...%s\n", mr.Token[:24], mr.Token[len(mr.Token)-12:])
	fmt.Printf("   grant: role=%s room=%s publish=%v subscribe=%v data=%v admin=%v ttl=%s\n",
		mr.Grant.Role, mr.Grant.Room, mr.Grant.CanPublish, mr.Grant.CanSubscribe,
		mr.Grant.CanPublishData, mr.Grant.RoomAdmin, mr.Grant.TTL)
	rule()

	// 2. Verify
	line("2) VERIFY that token for room-alpha + publish capability")
	vr := iss.Verify(token.VerifyRequest{Token: mr.Token, Room: "room-alpha", Capability: token.CapPublish})
	fmt.Printf("   valid=%v why=%q\n", vr.Valid, vr.Why)
	line("   VERIFY same token against room-beta (cross-room replay):")
	vr2 := iss.Verify(token.VerifyRequest{Token: mr.Token, Room: "room-beta", Capability: token.CapJoin})
	fmt.Printf("   valid=%v why=%q\n", vr2.Valid, vr2.Why)
	rule()

	// 3. Adversary
	line("3) ADVERSARY breaker suite")
	rep := adversary.Run()
	for _, c := range rep.Cases {
		status := "BLOCKED"
		if !c.Blocked {
			status = "**LEAK**"
		}
		fmt.Printf("   [%s] %-26s %s\n", status, c.Name, c.Detail)
	}
	fmt.Printf("   block_rate = %.2f  (%d/%d blocked)\n", rep.BlockRate, rep.Blocked, rep.Total)
	rule()

	// 4. Grant lint (offline path; an intentionally over-permissioned grant)
	line("4) GRANT LINT of an over-permissioned subscriber (no room scope, can publish, 24h ttl)")
	lr := grant.Explain(context.Background(), grant.Proposal{
		Role: "subscriber", Room: "", CanPublish: true, CanSubscribe: true,
		CanPublishData: true, TTLSeconds: 24 * 3600,
	})
	fmt.Printf("   allows: %v\n", lr.Allows)
	for _, f := range lr.Findings {
		fmt.Printf("   - [%s] %s\n", f.Severity, f.Message)
	}
	fmt.Printf("   risk_score=%d least_priv=%v provider=%s\n", lr.RiskScore, lr.LeastPriv, lr.Provider)
	fmt.Printf("   explanation: %s\n", lr.Explanation)
	rule()

	// 5. Threat model
	line("5) THREAT MODEL")
	for _, e := range threatmodel.Model() {
		fmt.Printf("   %s  %s\n", e.ID, e.Threat)
	}
	rule()
	line("done — fully offline, zero keys, block_rate above should read 1.00")
}
