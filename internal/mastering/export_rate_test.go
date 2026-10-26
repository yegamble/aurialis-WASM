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
}
