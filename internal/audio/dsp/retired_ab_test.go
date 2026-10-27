package dsp

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// V1-11: the engine no longer level-matches monitoring. Its former 42 ms RMS
// tracker partly undid the dynamics it was comparing. Matched A/B is now one
// static, attenuate-only gain in the live transport, never in the engine.

func TestRetiredLoudnessMatchIsNotSerialized(t *testing.T) {
	encoded, err := json.Marshal(DefaultParams())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("loudnessMatchAb")) {
		t.Fatal("new settings must not carry the retired loudnessMatchAb field")
	}
}

func TestRetiredLoudnessMatchAcceptsOnlyLegacyFalse(t *testing.T) {
	// Saved projects and scripts written before V1-11 carry "loudnessMatchAb": false.
	params, err := DecodeParamsJSON([]byte(`{"loudnessMatchAb":false,"inputGainDb":-3}`), DefaultParams())
	if err != nil {
		t.Fatalf("legacy false must still decode: %v", err)
	}
	if params.InputGainDB != -3 {
		t.Fatal("legacy field changed unrelated settings")
	}
	_, err = DecodeParamsJSON([]byte(`{"loudnessMatchAb":true}`), DefaultParams())
	if err == nil || !strings.Contains(err.Error(), "loudnessMatchAb") {
		t.Fatalf("enabling the retired engine match must be rejected by name, got %v", err)
	}
}

// The removed tracker only changed output when enabled, so every supported
// configuration must render identically to a fresh engine that never had it.
func TestABOriginalIsTheUnscaledSourceAfterAGCRemoval(t *testing.T) {
	left, right := generateToneStereo(48000, 1000, 0.5, 0.25, 0.25)
	p := DefaultParams()
	p.InputGainDB = -12
	p.Compressor.Ratio = 4
	p.Compressor.ThresholdDB = -24
	p.ABOriginal = true
	outL, outR, _ := RenderBuffer(left, right, 48000, p)
	for i := range outL {
		if outL[i] != left[i] || outR[i] != right[i] {
			t.Fatalf("B Original changed the source at frame %d", i)
		}
	}
}
