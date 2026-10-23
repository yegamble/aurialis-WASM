// Package build exposes the processing identity linked by qualified builds.
package build

// Fingerprint is injected by the complete build scripts, never inferred at runtime.
// A plain go build leaves it empty and cannot qualify stored processing continuation.
var Fingerprint string

// QualifiedFingerprint returns a closed build-input digest, not an executable hash.
func QualifiedFingerprint() string {
	if len(Fingerprint) != 64 {
		return ""
	}
	for _, character := range Fingerprint {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return ""
		}
	}
	return Fingerprint
}
