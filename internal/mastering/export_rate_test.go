package mastering

import (
	"context"
	"errors"
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
	if o.RenderDitherBits(44100, 16) != 0 || (ExportOptions{}).RenderDitherBits(44100, 16) != 16 || (ExportOptions{NoDither: true}).RenderDitherBits(44100, 24) != 0 {
		t.Fatal("render dither must wait for conversion and honor dither none")
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
