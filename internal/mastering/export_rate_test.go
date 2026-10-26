package mastering

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

func TestConvertExportRejectsOutputBeyondFrameLimit(t *testing.T) {
	o, err := ParseExportOptions(96000, "")
	if err != nil {
		t.Fatal(err)
	}
	// Only the length matters: the bound is checked before any allocation.
	frames := audio.MaxDecodedFrames/2 + 1
	silent := make([]float32, frames)
	if _, _, _, _, err := ConvertExportContext(context.Background(), silent, silent, 44100, 24, dsp.DefaultParams(), dsp.Metrics{}, o); !errors.Is(err, ErrExportTooLong) {
		t.Fatalf("err = %v, want ErrExportTooLong", err)
	}
	for _, bad := range []struct {
		rate   int
		dither string
	}{{22050, ""}, {48000, "shaped"}} {
		if _, err := ParseExportOptions(bad.rate, bad.dither); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	if o.RenderDitherBits(44100, 16, 0) != 0 || (ExportOptions{}).RenderDitherBits(44100, 16, 0) != 16 || (ExportOptions{NoDither: true}).RenderDitherBits(44100, 24, 16) != 0 {
		t.Fatal("render dither must wait for conversion and honor dither none")
	}
	if o.DitherBits(16, 0) != 16 || (ExportOptions{SampleRate: 48000, NoDither: true}).DitherBits(24, 24) != 0 || o.DitherBits(32, 16) != 16 || (ExportOptions{}).RenderDitherBits(44100, 32, 24) != 24 {
		t.Fatal("delivered dither must follow the bit depth, dither none, and 32-bit params")
	}
	// The bound is checked on the converted length before rendering.
	at96 := ExportOptions{SampleRate: 96000}
	if at96.Validate(audio.MaxDecodedFrames/12, 8000) != nil || !errors.Is(at96.Validate(audio.MaxDecodedFrames/12+1, 8000), ErrExportTooLong) {
		t.Fatal("8 kHz → 96 kHz bound is not exactly MaxDecodedFrames output frames")
	}
	if err := (ExportOptions{SampleRate: 48000}).Validate(4096, 44056); err == nil {
		t.Fatal("a 6000/5507 ratio was accepted")
	}
	if (ExportOptions{SampleRate: 44100}).Validate(audio.MaxDecodedFrames*4, 44100) != nil {
		t.Fatal("an unconverted export must not be validated as a conversion")
	}
	for raw, want := range map[string]int{"": 0, "44100": 44100, "48000": 48000, "88200": 88200, "96000": 96000} {
		if got, err := ParseExportSampleRate(raw); err != nil || got != want {
			t.Errorf("ParseExportSampleRate(%q) = %d, %v", raw, got, err)
		}
	}
	for _, raw := range []string{"0", "+48000", "048000", " 48000", "48000\n", "22050", "48e3"} {
		if _, err := ParseExportSampleRate(raw); !errors.Is(err, ErrInvalidSampleRate) {
			t.Errorf("ParseExportSampleRate(%q) accepted", raw)
		}
	}
}

func TestConvertExportAddsDeliveryGainReduction(t *testing.T) {
	// Hot noise through the v1 limiter leaves inter-sample overs that the
	// delivery limiter must pull down, and that reduction must be reported.
	left, right := make([]float32, 24000), make([]float32, 24000)
	state := uint32(7)
	for i := range left {
		state = state*1664525 + 1013904223
		left[i] = float32(2*float64(state)/math.MaxUint32 - 1)
		right[i] = -left[i]
	}
	p := dsp.DefaultParams()
	p.InputGainDB = 9
	p.Limiter.Enabled = true
	renderedL, renderedR, rendered, err := dsp.RenderBufferContext(context.Background(), left, right, 48000, p)
	if err != nil {
		t.Fatal(err)
	}
	_, _, delivered, rate, err := ConvertExportContext(context.Background(), renderedL, renderedR, 48000, 24, p, rendered, ExportOptions{SampleRate: 44100})
	if err != nil || rate != 44100 {
		t.Fatalf("rate %d, err %v", rate, err)
	}
	if delivered.GainReductionDB <= rendered.GainReductionDB {
		t.Fatalf("delivered gain reduction %.2f dB omits the delivery limiter (render %.2f dB)", delivered.GainReductionDB, rendered.GainReductionDB)
	}
	if delivered.TruePeakDBTP > p.Limiter.CeilingDBTP {
		t.Fatalf("delivered %.2f dBTP above the ceiling", delivered.TruePeakDBTP)
	}
}
