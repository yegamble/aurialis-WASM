package server_test

import (
	"bytes"
	"encoding/binary"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

// A ScriptV2 export at the source rate must still receive the delivery's
// default dither. Transform-only tests cannot establish the encoded result.
func TestSameRateScriptExportDefaultsToSixteenBitDither(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	source := buildTestWAV(t, 44100, .2)
	script := encodedScript(t, apiScript(t, source))
	render := func(noDither bool) []byte {
		fields := map[string]string{"script": script, "bitDepth": "16"}
		if noDither {
			fields["dither"] = "none"
		}
		response := httptest.NewRecorder()
		srv.Handler().ServeHTTP(response, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", source, fields))
		if response.Code != http.StatusOK {
			t.Fatalf("render status %d: %s", response.Code, response.Body.String())
		}
		wav := response.Body.Bytes()
		if len(wav) < 44 || binary.LittleEndian.Uint32(wav[24:28]) != 44100 || binary.LittleEndian.Uint16(wav[34:36]) != 16 {
			t.Fatal("delivery did not retain 44.1 kHz/16-bit PCM")
		}
		return wav
	}
	dithered, plain := render(false), render(true)
	if len(dithered) != len(plain) || bytes.Equal(dithered, plain) {
		t.Fatal("default same-rate script delivery did not apply dither")
	}
	withDither, err := audio.DecodeAndDisarm("dithered.wav", dithered)
	if err != nil {
		t.Fatal(err)
	}
	withoutDither, err := audio.DecodeAndDisarm("plain.wav", plain)
	if err != nil {
		t.Fatal(err)
	}
	changed := 0
	for i := range withDither.Left {
		for _, delta := range [2]float64{float64(withDither.Left[i] - withoutDither.Left[i]), float64(withDither.Right[i] - withoutDither.Right[i])} {
			if math.Abs(delta) > 1.0/32768 {
				t.Fatalf("dither changed the signal beyond one PCM step at %d: %g", i, delta)
			}
			if delta != 0 {
				changed++
			}
		}
	}
	if changed < withDither.Frames/10 {
		t.Fatalf("too few samples carry TPDF dither: %d of %d", changed, withDither.Frames*2)
	}
	t.Logf("44.1 kHz/16-bit ScriptV2: %d of %d samples differ by one PCM step", changed, withDither.Frames*2)
}
