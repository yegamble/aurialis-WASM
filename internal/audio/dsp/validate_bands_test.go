package dsp

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestParamsJSONBandKeyVariants(t *testing.T) {
	base := DefaultParams()
	base.InputGainDB = 2
	valid, err := json.Marshal(base.Bands)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"bands", "Bands", "BANDS", "bAnDs"} {
		t.Run(key, func(t *testing.T) {
			payload := fmt.Sprintf(`{%q:%s}`, key, valid)
			next, err := DecodeParamsJSON([]byte(payload), base)
			if err != nil || next != base {
				t.Fatalf("valid case variant changed settings or was rejected: %v", err)
			}
		})
	}
}

func TestParamsJSONRejectsMalformedBandKeyVariants(t *testing.T) {
	base := DefaultParams()
	valid, err := json.Marshal(base.Bands)
	if err != nil {
		t.Fatal(err)
	}
	six := append(base.Bands[:], base.Bands[0])
	extra, err := json.Marshal(six)
	if err != nil {
		t.Fatal(err)
	}
	partial := make([]map[string]any, NumEQBands)
	for i := range partial {
		partial[i] = map[string]any{"freqHz": 1000, "gainDb": 1, "q": 1, "type": "peaking"}
	}
	missing, err := json.Marshal(partial)
	if err != nil {
		t.Fatal(err)
	}
	invalid := base.Bands
	invalid[0].Q = 0
	outOfRange, err := json.Marshal(invalid)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"bands", "Bands", "BANDS", "bAnDs"} {
		for name, raw := range map[string]string{
			"empty": `[]`, "extra": string(extra), "null": `null`,
			"null bands": `[null,null,null,null,null]`, "partial": string(missing),
			"out of range": string(outOfRange),
		} {
			t.Run(key+"/"+name, func(t *testing.T) {
				payloads := []string{fmt.Sprintf(`{%q:%s}`, key, raw)}
				if key != "bands" {
					payloads = append(payloads, fmt.Sprintf(`{"bands":%s,%q:%s}`, valid, key, raw))
					if name != "out of range" {
						payloads = append(payloads, fmt.Sprintf(`{%q:%s,"bands":%s}`, key, raw, valid))
					}
				}
				for _, payload := range payloads {
					next, err := DecodeParamsJSON([]byte(payload), base)
					if err == nil || next != base {
						t.Fatalf("malformed variant accepted or changed base: %s (%v)", payload, err)
					}
				}
			})
		}
	}
}

func TestParamsJSONMultibandKeyVariants(t *testing.T) {
	base := DefaultParams()
	valid, err := json.Marshal(base.Multiband.Bands)
	if err != nil {
		t.Fatal(err)
	}
	four := append(base.Multiband.Bands[:], base.Multiband.Bands[0])
	extra, err := json.Marshal(four)
	if err != nil {
		t.Fatal(err)
	}
	for _, module := range []string{"multiband", "Multiband", "MULTIBAND"} {
		for _, key := range []string{"bands", "Bands", "BANDS"} {
			t.Run(module+"/"+key, func(t *testing.T) {
				payload := fmt.Sprintf(`{%q:{%q:%s}}`, module, key, valid)
				if next, err := DecodeParamsJSON([]byte(payload), base); err != nil || next != base {
					t.Fatalf("valid multiband variant rejected or changed base: %v", err)
				}
				for _, raw := range []string{`[]`, string(extra), `null`, `[null,null,null]`, `[{"ratio":2},{"ratio":2},{"ratio":2}]`} {
					payloads := []string{fmt.Sprintf(`{%q:{%q:%s}}`, module, key, raw)}
					if module != "multiband" {
						payloads = append(payloads,
							fmt.Sprintf(`{"multiband":{"bands":%s},%q:{%q:%s}}`, valid, module, key, raw),
							fmt.Sprintf(`{%q:{%q:%s},"multiband":{"bands":%s}}`, module, key, raw, valid))
					}
					if key != "bands" {
						payloads = append(payloads,
							fmt.Sprintf(`{%q:{"bands":%s,%q:%s}}`, module, valid, key, raw),
							fmt.Sprintf(`{%q:{%q:%s,"bands":%s}}`, module, key, raw, valid))
					}
					for _, payload := range payloads {
						if next, err := DecodeParamsJSON([]byte(payload), base); err == nil || next != base {
							t.Fatalf("malformed multiband variant accepted or changed base: %s (%v)", payload, err)
						}
					}
				}
			})
		}
	}
}

func TestParamsJSONExactDuplicateBandKeysKeepLastValue(t *testing.T) {
	base := DefaultParams()
	valid, err := json.Marshal(base.Bands)
	if err != nil {
		t.Fatal(err)
	}
	multiband, err := json.Marshal(base.Multiband.Bands)
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		fmt.Sprintf(`{"Bands":[],"Bands":%s}`, valid),
		fmt.Sprintf(`{"Multiband":{"Bands":[],"Bands":%s}}`, multiband),
		fmt.Sprintf(`{"Multiband":{"Bands":[]},"Multiband":{"Bands":%s}}`, multiband),
	} {
		if next, err := DecodeParamsJSON([]byte(payload), base); err != nil || next != base {
			t.Fatalf("exact duplicate no longer uses final value: %v", err)
		}
	}
}
