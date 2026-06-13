// Package token mints and verifies scoped real-time room access tokens on top of
// the open-source livekit/protocol auth package — the de-facto standard WebRTC
// room-token library. A token is a JWT (HS256) carrying a VideoGrant with a room
// scope, granular publish/subscribe capabilities, and a bounded TTL.
//
// The security core here is deterministic: minting derives a grant from a vetted
// role template, and verification both checks the signature/expiry (via the
// upstream verifier) and re-asserts the room scope and the required capability.
package token

import (
	"errors"
	"fmt"
	"time"

	"github.com/livekit/protocol/auth"
)

// Role is a vetted least-privilege template. A caller picks a role; the grant is
// derived from it, never hand-assembled per request.
type Role string

const (
	// RolePublisher can join one room and publish + subscribe + send data.
	RolePublisher Role = "publisher"
	// RoleSubscriber can join one room and subscribe only (a listener).
	RoleSubscriber Role = "subscriber"
	// RoleAdmin can join + administer one room (publish, subscribe, room admin).
	RoleAdmin Role = "admin"
)

// Capability is a verifiable permission a verifier can require of a token.
type Capability string

const (
	CapJoin        Capability = "join"
	CapPublish     Capability = "publish"
	CapSubscribe   Capability = "subscribe"
	CapPublishData Capability = "publishData"
	CapAdmin       Capability = "admin"
)

// Default and maximum TTLs. A token with no requested TTL gets DefaultTTL; a
// request over MaxTTL is clamped (over-long lifetimes are the most common
// real-world over-grant).
const (
	DefaultTTL = 1 * time.Hour
	MaxTTL     = 12 * time.Hour
	MinTTL     = 1 * time.Minute
)

var (
	ErrUnknownRole = errors.New("unknown role")
	ErrEmptyRoom   = errors.New("room scope is required")
	ErrEmptyKeys   = errors.New("api key and secret are required")
)

// boolPtr is a helper for the *bool capability fields in VideoGrant.
func boolPtr(b bool) *bool { return &b }

// grantForRole returns a fresh VideoGrant for a role, scoped to room. Each role
// is least-privilege: a subscriber cannot publish; only an admin gets RoomAdmin.
func grantForRole(role Role, room string) (*auth.VideoGrant, error) {
	switch role {
	case RolePublisher:
		return &auth.VideoGrant{
			RoomJoin:       true,
			Room:           room,
			CanPublish:     boolPtr(true),
			CanSubscribe:   boolPtr(true),
			CanPublishData: boolPtr(true),
		}, nil
	case RoleSubscriber:
		return &auth.VideoGrant{
			RoomJoin:       true,
			Room:           room,
			CanPublish:     boolPtr(false),
			CanSubscribe:   boolPtr(true),
			CanPublishData: boolPtr(false),
		}, nil
	case RoleAdmin:
		return &auth.VideoGrant{
			RoomJoin:       true,
			RoomAdmin:      true,
			Room:           room,
			CanPublish:     boolPtr(true),
			CanSubscribe:   boolPtr(true),
			CanPublishData: boolPtr(true),
		}, nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownRole, role)
	}
}

// Roles lists the available role templates, in escalating-privilege order.
func Roles() []Role { return []Role{RoleSubscriber, RolePublisher, RoleAdmin} }

// Issuer mints tokens with a fixed API key/secret pair (the signing key).
type Issuer struct {
	apiKey string
	secret string
}

// NewIssuer builds an Issuer. The secret is the HS256 signing key; it never
// leaves the server and is never embedded in a minted token.
func NewIssuer(apiKey, secret string) (*Issuer, error) {
	if apiKey == "" || secret == "" {
		return nil, ErrEmptyKeys
	}
	return &Issuer{apiKey: apiKey, secret: secret}, nil
}

// MintRequest is one mint call: a role template bound to a room, an identity, and
// an optional TTL (clamped to [MinTTL, MaxTTL]).
type MintRequest struct {
	Role     Role          `json:"role"`
	Room     string        `json:"room"`
	Identity string        `json:"identity"`
	TTL      time.Duration `json:"ttl"`
}

// DecodedGrant is the human-readable view of what a token allows.
type DecodedGrant struct {
	Role           Role      `json:"role"`
	Identity       string    `json:"identity"`
	Room           string    `json:"room"`
	RoomJoin       bool      `json:"room_join"`
	RoomAdmin      bool      `json:"room_admin"`
	CanPublish     bool      `json:"can_publish"`
	CanSubscribe   bool      `json:"can_subscribe"`
	CanPublishData bool      `json:"can_publish_data"`
	TTL            string    `json:"ttl"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// MintResult is the JWT plus the decoded grant it carries.
type MintResult struct {
	Token string       `json:"token"`
	Grant DecodedGrant `json:"grant"`
}

// clampTTL keeps the requested lifetime inside policy bounds.
func clampTTL(ttl time.Duration) time.Duration {
	switch {
	case ttl <= 0:
		return DefaultTTL
	case ttl < MinTTL:
		return MinTTL
	case ttl > MaxTTL:
		return MaxTTL
	default:
		return ttl
	}
}

// Mint derives a grant from the role template, scopes it to the room, sets the
// (clamped) TTL, and signs the JWT with the issuer secret.
func (iss *Issuer) Mint(req MintRequest) (*MintResult, error) {
	if req.Room == "" {
		return nil, ErrEmptyRoom
	}
	grant, err := grantForRole(req.Role, req.Room)
	if err != nil {
		return nil, err
	}
	ttl := clampTTL(req.TTL)
	identity := req.Identity
	if identity == "" {
		identity = string(req.Role) + "-" + req.Room
	}

	at := auth.NewAccessToken(iss.apiKey, iss.secret).
		SetIdentity(identity).
		SetVideoGrant(grant).
		SetValidFor(ttl)

	jwt, err := at.ToJWT()
	if err != nil {
		return nil, err
	}
	return &MintResult{
		Token: jwt,
		Grant: DecodedGrant{
			Role:           req.Role,
			Identity:       identity,
			Room:           grant.Room,
			RoomJoin:       grant.RoomJoin,
			RoomAdmin:      grant.RoomAdmin,
			CanPublish:     grant.GetCanPublish(),
			CanSubscribe:   grant.GetCanSubscribe(),
			CanPublishData: grant.GetCanPublishData(),
			TTL:            ttl.String(),
			ExpiresAt:      time.Now().Add(ttl).UTC(),
		},
	}, nil
}

// VerifyRequest checks a token against a required room and capability.
type VerifyRequest struct {
	Token      string     `json:"token"`
	Room       string     `json:"room"`
	Capability Capability `json:"capability"`
}

// VerifyResult is the verdict plus the reason and (on success) the decoded grant.
type VerifyResult struct {
	Valid bool          `json:"valid"`
	Why   string        `json:"why"`
	Grant *DecodedGrant `json:"grant,omitempty"`
}

// Verify checks signature + expiry (via the upstream verifier), then re-asserts
// the room scope and the required capability. A cryptographically valid token
// that does not cover the requested room or capability is rejected.
func (iss *Issuer) Verify(req VerifyRequest) VerifyResult {
	if req.Token == "" {
		return VerifyResult{Valid: false, Why: "empty token"}
	}
	v, err := auth.ParseAPIToken(req.Token)
	if err != nil {
		return VerifyResult{Valid: false, Why: "malformed token: " + err.Error()}
	}
	// Verify enforces signature, issuer match, and expiry/not-before.
	_, grants, err := v.Verify(iss.secret)
	if err != nil {
		return VerifyResult{Valid: false, Why: "signature/claims invalid: " + err.Error()}
	}
	vg := grants.Video
	if vg == nil {
		return VerifyResult{Valid: false, Why: "no video grant in token"}
	}

	// Room scope: a token is only valid for the room it was scoped to. An empty
	// room scope in the token means "valid in every room" — a dangerous grant we
	// refuse to honor for a room-scoped check.
	if req.Room != "" {
		if vg.Room == "" {
			return VerifyResult{Valid: false, Why: "token has no room scope (would be valid in every room)"}
		}
		if vg.Room != req.Room {
			return VerifyResult{Valid: false, Why: fmt.Sprintf("room mismatch: token scoped to %q, required %q", vg.Room, req.Room)}
		}
	}

	if ok, why := capabilitySatisfied(vg, req.Capability); !ok {
		return VerifyResult{Valid: false, Why: why}
	}

	return VerifyResult{
		Valid: true,
		Why:   "ok",
		Grant: &DecodedGrant{
			Identity:       grants.Identity,
			Room:           vg.Room,
			RoomJoin:       vg.RoomJoin,
			RoomAdmin:      vg.RoomAdmin,
			CanPublish:     vg.GetCanPublish(),
			CanSubscribe:   vg.GetCanSubscribe(),
			CanPublishData: vg.GetCanPublishData(),
		},
	}
}

func capabilitySatisfied(vg *auth.VideoGrant, cap Capability) (bool, string) {
	switch cap {
	case "", CapJoin:
		if !vg.RoomJoin {
			return false, "token does not grant room join"
		}
	case CapPublish:
		if !vg.GetCanPublish() {
			return false, "token does not grant publish"
		}
	case CapSubscribe:
		if !vg.GetCanSubscribe() {
			return false, "token does not grant subscribe"
		}
	case CapPublishData:
		if !vg.GetCanPublishData() {
			return false, "token does not grant data-channel publish"
		}
	case CapAdmin:
		if !vg.RoomAdmin {
			return false, "token does not grant room admin"
		}
	default:
		return false, fmt.Sprintf("unknown capability %q", cap)
	}
	return true, "ok"
}
