// Package grant is the LLM-backed grant risk explainer. Given a proposed room
// access grant, it returns a plain-English explanation of what the grant allows
// and a list of over-permissioning findings measured against least-privilege
// templates. The deterministic rule checker (Lint) is the source of truth and the
// offline fallback; the LLM only narrates it.
package grant

import (
	"context"
	"fmt"
	"strings"
	"time"

	"relaytoken/internal/llm"
)

// Proposal is a grant a caller wants to issue, before it is signed.
type Proposal struct {
	Role           string `json:"role"` // intended role template, if any
	Room           string `json:"room"` // room scope ("" == every room)
	CanPublish     bool   `json:"can_publish"`
	CanSubscribe   bool   `json:"can_subscribe"`
	CanPublishData bool   `json:"can_publish_data"`
	RoomAdmin      bool   `json:"room_admin"`
	TTLSeconds     int    `json:"ttl_seconds"`
}

// Severity ranks a finding.
type Severity string

const (
	SevHigh   Severity = "high"
	SevMedium Severity = "medium"
	SevLow    Severity = "low"
)

// Finding is one over-permissioning observation.
type Finding struct {
	Severity Severity `json:"severity"`
	Code     string   `json:"code"`
	Message  string   `json:"message"`
}

// LintResult is the deterministic verdict.
type LintResult struct {
	Allows      []string  `json:"allows"`      // capabilities this grant confers
	Findings    []Finding `json:"findings"`    // over-permissioning issues
	RiskScore   int       `json:"risk_score"`  // 0..100, higher = riskier
	LeastPriv   bool      `json:"least_priv"`  // true if no findings
	Explanation string    `json:"explanation"` // plain-English (LLM or offline)
	Provider    string    `json:"provider"`    // who wrote the explanation
}

// Recommended TTL ceiling for an interactive participant token.
const recommendedMaxTTL = 12 * time.Hour

// Lint runs the deterministic over-permissioning checks. This is the trust-
// critical core; the LLM never overrides it.
func Lint(p Proposal) LintResult {
	var allows []string
	if p.CanSubscribe {
		allows = append(allows, "subscribe to media")
	}
	if p.CanPublish {
		allows = append(allows, "publish media (mic/camera)")
	}
	if p.CanPublishData {
		allows = append(allows, "publish on the data channel")
	}
	if p.RoomAdmin {
		allows = append(allows, "administer the room (kick/mute/update)")
	}
	if len(allows) == 0 {
		allows = append(allows, "join only (no media)")
	}

	var findings []Finding

	// Missing room scope: the single most dangerous over-grant — valid everywhere.
	if strings.TrimSpace(p.Room) == "" {
		findings = append(findings, Finding{
			Severity: SevHigh, Code: "no_room_scope",
			Message: "no room scope set: this token is valid in EVERY room, not one. Bind it to a single room.",
		})
	}

	// A subscriber that can publish is over-permissioned vs the listener template.
	if p.Role == "subscriber" && p.CanPublish {
		findings = append(findings, Finding{
			Severity: SevHigh, Code: "subscriber_can_publish",
			Message: "role is 'subscriber' (a listener) but the grant allows publishing — drop canPublish to match least privilege.",
		})
	}

	// Data-channel publish is the prompt-injection surface into a voice-AI agent.
	if p.CanPublishData && p.Role == "subscriber" {
		findings = append(findings, Finding{
			Severity: SevMedium, Code: "subscriber_data_channel",
			Message: "a listener with data-channel publish can inject messages the AI agent may treat as instructions (prompt injection). Restrict canPublishData.",
		})
	}

	// Room admin on a non-admin role.
	if p.RoomAdmin && p.Role != "admin" {
		findings = append(findings, Finding{
			Severity: SevHigh, Code: "unexpected_room_admin",
			Message: fmt.Sprintf("roomAdmin granted to a '%s' role: this allows kicking/muting others. Reserve admin for the admin template.", p.Role),
		})
	}

	// TTL hygiene.
	switch {
	case p.TTLSeconds <= 0:
		findings = append(findings, Finding{
			Severity: SevMedium, Code: "no_ttl",
			Message: "no TTL set: a token without a bounded lifetime is a standing credential. Set a short, explicit TTL.",
		})
	case time.Duration(p.TTLSeconds)*time.Second > recommendedMaxTTL:
		findings = append(findings, Finding{
			Severity: SevMedium, Code: "over_long_ttl",
			Message: fmt.Sprintf("TTL of %s exceeds the %s ceiling for an interactive token — shorten it to limit replay/leak windows.",
				(time.Duration(p.TTLSeconds) * time.Second).String(), recommendedMaxTTL.String()),
		})
	}

	risk := 0
	for _, f := range findings {
		switch f.Severity {
		case SevHigh:
			risk += 40
		case SevMedium:
			risk += 20
		case SevLow:
			risk += 10
		}
	}
	if risk > 100 {
		risk = 100
	}

	return LintResult{
		Allows:    allows,
		Findings:  findings,
		RiskScore: risk,
		LeastPriv: len(findings) == 0,
	}
}

// offlineExplanation deterministically narrates a LintResult — the always-terminal
// fallback used when no LLM provider is configured.
func offlineExplanation(lr LintResult) string {
	var b strings.Builder
	b.WriteString("This grant allows: " + strings.Join(lr.Allows, ", ") + ". ")
	if lr.LeastPriv {
		b.WriteString("It matches a least-privilege template — no over-permissioning detected.")
		return b.String()
	}
	b.WriteString(fmt.Sprintf("%d over-permissioning finding(s) (risk %d/100): ", len(lr.Findings), lr.RiskScore))
	parts := make([]string, 0, len(lr.Findings))
	for _, f := range lr.Findings {
		parts = append(parts, fmt.Sprintf("[%s] %s", strings.ToUpper(string(f.Severity)), f.Message))
	}
	b.WriteString(strings.Join(parts, " "))
	return b.String()
}

const explainSystem = `You are a least-privilege reviewer for real-time room access tokens.
You are given a proposed grant and a deterministic rule-checker's findings.
Explain in plain English what the grant lets a holder do, then summarize the
over-permissioning findings and the single most important fix. Be concise (4-6
sentences), concrete, and do NOT invent findings beyond those provided.`

// Explain runs Lint, then asks the LLM router to narrate it, falling back to a
// deterministic explanation offline. The findings/risk are always from Lint; only
// the prose comes from the model.
func Explain(ctx context.Context, p Proposal) LintResult {
	lr := Lint(p)
	offline := func(system, user string) string { return offlineExplanation(lr) }

	user := fmt.Sprintf(
		"Proposed grant: role=%q room=%q canPublish=%v canSubscribe=%v canPublishData=%v roomAdmin=%v ttl_seconds=%d.\nRule-checker findings: %s",
		p.Role, p.Room, p.CanPublish, p.CanSubscribe, p.CanPublishData, p.RoomAdmin, p.TTLSeconds,
		offlineExplanation(lr),
	)
	res := llm.Complete(ctx, explainSystem, user, offline, llm.Options{MaxTokens: 400})
	lr.Explanation = strings.TrimSpace(res.Text)
	lr.Provider = res.Provider
	return lr
}
