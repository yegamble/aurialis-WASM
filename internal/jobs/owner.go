package jobs

import (
	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// Scope binds all admissions and artifact access to an immutable authenticated owner.
// The caller authenticates the owner; the empty owner is reserved for local callers.
// Ownership is private metadata and is never included in client job JSON.
type Scope struct {
	manager *Manager
	owner   string
}

// ForOwner returns a lightweight view over the same bounded manager and worker pool.
func (m *Manager) ForOwner(owner string) Scope { return Scope{manager: m, owner: owner} }

// SubmitSeparate admits separation within this owner's namespace.
func (s Scope) SubmitSeparate(buf *audio.Buffer, count int) (*Job, error) {
	return s.manager.submitSeparate(s.owner, buf, count)
}

// SubmitAnalyzeDeep admits legacy analysis within this owner's namespace.
func (s Scope) SubmitAnalyzeDeep(buf *audio.Buffer, profile mastering.ProfileID) (*Job, error) {
	return s.manager.submitAnalyzeDeep(s.owner, buf, profile)
}

// SubmitAnalyzeDeepV2 admits measured automation within this owner's namespace.
func (s Scope) SubmitAnalyzeDeepV2(buf *audio.Buffer, profile mastering.ProfileID) (*Job, error) {
	return s.manager.submitAnalyzeDeepV2(s.owner, buf, profile)
}

// SubmitAnalyzeFeatures admits feature analysis within this owner's namespace.
func (s Scope) SubmitAnalyzeFeatures(buf *audio.Buffer) (*Job, error) {
	return s.manager.submitAnalyzeFeatures(s.owner, buf)
}

// SubmitAnalyzeReference admits both reference sources within this owner's namespace.
func (s Scope) SubmitAnalyzeReference(source, reference *audio.Buffer, baseline dsp.Params, options mastering.ReferenceOptions) (*Job, error) {
	return s.manager.submitAnalyzeReference(s.owner, source, reference, baseline, options)
}

// Get returns only this owner's job snapshots.
func (s Scope) Get(id string) (*Job, bool) { return s.manager.get(s.owner, id) }

// Cancel affects only this owner's jobs; unknown and foreign jobs are indistinguishable.
func (s Scope) Cancel(id string) (*Job, bool) { return s.manager.cancel(s.owner, id) }

// StemWAV returns only this owner's completed reconstructed audio artifacts.
func (s Scope) StemWAV(id, stem string) ([]byte, bool) {
	return s.manager.stemWAV(s.owner, id, stem)
}
