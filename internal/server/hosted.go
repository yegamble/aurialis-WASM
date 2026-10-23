package server

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
)

// HostedMaxUploadBytes stays below the canonical Free zone's 100 MB request limit.
// The bound covers the complete multipart request, including both reference files.
const HostedMaxUploadBytes int64 = 95 * 1024 * 1024

const gatewayHeader = "X-Aurialis-Gateway"
const ownerHeader = "X-Aurialis-Session"

// HostedConfig explicitly enables the private authenticated container listener.
// GatewaySecret is a 32-byte random secret encoded as 64 lowercase hexadecimal digits.
// Origins contains only fixed exact HTTPS origins, never request-derived configuration.
type HostedConfig struct {
	Origins       []string
	GatewaySecret string
}

// Validate rejects partial or ambiguous public gateway configuration.
func (c HostedConfig) Validate() error {
	if len(c.Origins) < 1 || len(c.Origins) > 3 {
		return errors.New("hosted mode requires between one and three fixed HTTPS origins")
	}
	if !validOwnerID(c.GatewaySecret) {
		return errors.New("hosted mode requires a 32-byte lowercase hexadecimal gateway secret")
	}
	seen := make(map[string]bool, len(c.Origins))
	for _, origin := range c.Origins {
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.Host != strings.ToLower(u.Host) || u.Port() != "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(u.Host, "\t\r\n ,\\") || seen[origin] {
			return errors.New("hosted origins must be unique exact HTTPS hostnames without ports or paths")
		}
		seen[origin] = true
	}
	return nil
}

type ownerContextKey struct{}

func validOwnerID(owner string) bool {
	if len(owner) != 64 || strings.ToLower(owner) != owner {
		return false
	}
	_, err := hex.DecodeString(owner)
	return err == nil
}

func (s *Server) requestJobs(r *http.Request) jobs.Scope {
	owner, _ := r.Context().Value(ownerContextKey{}).(string)
	return s.jobs.ForOwner(owner)
}

func (s *Server) authenticateHosted(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	if s.hostedErr != nil {
		writeErrorJSON(w, http.StatusServiceUnavailable, "hosted_not_configured", "The audio server gateway is unavailable")
		return nil, false
	}
	cfg := s.cfg.Hosted
	if len(r.Header.Values(gatewayHeader)) != 1 || subtle.ConstantTimeCompare([]byte(r.Header.Get(gatewayHeader)), []byte(cfg.GatewaySecret)) != 1 {
		writeErrorJSON(w, http.StatusForbidden, "forbidden_gateway", "An authenticated audio gateway is required")
		return nil, false
	}
	// The private proxy contract preserves the original exact public Host. No
	// forwarded-host/protocol fields may override it, even with valid credentials.
	for _, name := range []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-For"} {
		if _, exists := r.Header[http.CanonicalHeaderKey(name)]; exists {
			writeErrorJSON(w, http.StatusForbidden, "forbidden_gateway", "Ambiguous forwarding metadata is forbidden")
			return nil, false
		}
	}
	publicOrigin := "https://" + r.Host
	allowed := false
	for _, origin := range cfg.Origins {
		allowed = allowed || origin == publicOrigin
	}
	if !allowed {
		writeErrorJSON(w, http.StatusForbidden, "forbidden_host", "This public audio hostname is not configured")
		return nil, false
	}
	origin := r.Header.Get("Origin")
	if len(r.Header.Values("Origin")) > 1 || (origin != "" && origin != publicOrigin) || ((r.Method == http.MethodPost || r.Method == http.MethodDelete) && origin == "") {
		writeErrorJSON(w, http.StatusForbidden, "forbidden_origin", "An exact same-origin request is required")
		return nil, false
	}
	owner := r.Header.Get(ownerHeader)
	if len(r.Header.Values(ownerHeader)) > 1 || (owner != "" && !validOwnerID(owner)) || (isAudioPath(r.URL.Path) && owner == "") {
		writeErrorJSON(w, http.StatusForbidden, "forbidden_session", "An authenticated audio session is required")
		return nil, false
	}
	return r.WithContext(context.WithValue(r.Context(), ownerContextKey{}, owner)), true
}

func isAudioPath(path string) bool {
	return (strings.HasPrefix(path, "/api/") && path != "/api/health") || strings.HasPrefix(path, "/jobs/") || path == "/separate" || strings.HasPrefix(path, "/analyze/") || path == "/master/render"
}
