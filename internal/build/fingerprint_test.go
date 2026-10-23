package build

import (
	"strings"
	"testing"
)

func TestQualifiedFingerprint(t *testing.T) {
	original := Fingerprint
	t.Cleanup(func() { Fingerprint = original })
	for _, value := range []string{"", "development", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("0", 64)} {
		Fingerprint = value
		expected := ""
		if value == strings.Repeat("0", 64) {
			expected = value
		}
		if actual := QualifiedFingerprint(); actual != expected {
			t.Fatalf("QualifiedFingerprint(%q) = %q; want %q", value, actual, expected)
		}
	}
}
