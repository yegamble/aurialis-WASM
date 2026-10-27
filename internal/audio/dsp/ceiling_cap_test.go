package dsp

import (
	"errors"
	"strings"
	"testing"
)

// V1-09 (chair ruling): no limiter ceiling above -1 dBTP reaches the chain,
// whichever route supplies it. ValidateParams is the single choke point.
func TestValidateParamsCapsLimiterCeilingAtMinusOne(t *testing.T) {
	for _, ceiling := range []float64{-0.99, -0.5, -0.1, 0} {
		p := DefaultParams()
		p.Limiter.CeilingDBTP = ceiling
		err := ValidateParams(p)
		if err == nil || !strings.Contains(err.Error(), "limiter.ceilingDbtp") || !strings.Contains(err.Error(), "-1") {
			t.Fatalf("ceiling %.2f accepted or unexplained: %v", ceiling, err)
		}
		if _, err := DecodeParamsJSON([]byte(`{"limiter":{"enabled":true,"ceilingDbtp":-0.5,"targetLufs":-14,"releaseMs":80,"truePeak":true}}`), DefaultParams()); err == nil {
			t.Fatal("JSON ceiling -0.5 accepted")
		}
	}
	for _, ceiling := range []float64{MaxCeilingDBTP, -6, -24} {
		p := DefaultParams()
		p.Limiter.CeilingDBTP = ceiling
		if err := ValidateParams(p); err != nil {
			t.Fatalf("ceiling %.1f rejected: %v", ceiling, err)
		}
	}
	// A disabled limiter still carries a valid setting.
	p := DefaultParams()
	p.Limiter.Enabled = false
	p.Limiter.CeilingDBTP = -0.3
	if ValidateParams(p) == nil {
		t.Fatal("disabled limiter kept a -0.3 dBTP ceiling")
	}
}

// A known field with the wrong JSON type names the field and the expected
// type, never the request text, so the API can say which setting is wrong.
func TestDecodeParamsJSONNamesMistypedFields(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"limiter":{"ceilingDbtp":"-0.5"}}`, "limiter.ceilingDbtp must be a number"},
		{`{"inputGainDb":true}`, "inputGainDb must be a number"},
		{`{"stereo":{"monoBass":"yes"}}`, "stereo.monoBass must be a boolean"},
		{`{"compressor":7}`, "compressor must be an object"},
	} {
		_, err := DecodeParamsJSON([]byte(tc.body), DefaultParams())
		var rangeErr *RangeError
		if !errors.As(err, &rangeErr) || err.Error() != tc.want {
			t.Fatalf("%s: %v, want %q", tc.body, err, tc.want)
		}
	}
}
