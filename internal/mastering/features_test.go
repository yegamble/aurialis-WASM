package mastering

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
)

func featureSignal(sampleRate int, seconds float64, sample func(int) (float32, float32)) *audio.Buffer {
	count := int(float64(sampleRate) * seconds)
	buf := &audio.Buffer{SampleRate: sampleRate, Channels: 2, Frames: count, Duration: seconds, Left: make([]float32, count), Right: make([]float32, count)}
	for i := range buf.Left {
		buf.Left[i], buf.Right[i] = sample(i)
	}
	return buf
}

func TestFeatureBandPowerAndDensityOnTones(t *testing.T) {
	for _, rate := range []int{8000, 44100, 48000, 96000, 192000} {
		for band, frequency := range []float64{60, 250, 1000, 3000, 9000} {
			if frequency >= float64(rate)/2 {
				continue
			}
			buf := featureSignal(rate, 2, func(i int) (float32, float32) {
				value := float32(0.25 * math.Sin(2*math.Pi*frequency*float64(i)/float64(rate)))
				return value, -value
			})
			result, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
			if err != nil {
				t.Fatal(err)
			}
			want := 10 * math.Log10(0.25*0.25/2)
			if delta := math.Abs(result.Bands[band].PowerDB - want); delta > 0.5 {
				t.Fatalf("rate%d frequency%g power%g want%g delta%g", rate, frequency, result.Bands[band].PowerDB, want, delta)
			}
			if math.Abs(result.Bands[band].DensityDBPerHz-(result.Bands[band].PowerDB-10*math.Log10(result.Bands[band].BandwidthHz))) > 1e-8 {
				t.Fatal("density has wrong bandwidth normalization")
			}
		}
	}
}

func TestFeatureNoisePowerAndUnavailableBandwidth(t *testing.T) {
	for _, rate := range []int{8000, 48000, 192000} {
		random := rand.New(rand.NewPCG(1, 2)) // #nosec G404 -- deterministic acoustic fixture, not a security token
		buf := featureSignal(rate, 6, func(int) (float32, float32) {
			return float32(random.NormFloat64() * 0.1), float32(random.NormFloat64() * 0.1)
		})
		result, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, band := range result.Bands {
			if !band.Valid {
				if band.LowHz < float64(rate)/2 {
					t.Fatal("usable band marked unavailable")
				}
				continue
			}
			want := 10 * math.Log10(0.01*band.BandwidthHz/(float64(rate)/2))
			if math.Abs(band.PowerDB-want) > 0.5 {
				t.Fatalf("rate%d band%g..%g measured%g want%g", rate, band.LowHz, band.UsableHighHz, band.PowerDB, want)
			}
		}
		if rate == 8000 && (result.Bands[4].Valid || result.Bands[3].UsableHighHz != 4000 || len(result.Warnings) == 0) {
			t.Fatal("Nyquist bandwidth not represented")
		}
	}
}

func TestFeatureSilenceConstantAndShortSignalsHaveOneNeutralSection(t *testing.T) {
	for _, seconds := range []float64{1.0 / 8000, 0.1, 1, 24} {
		for _, level := range []float32{0, 0.1} {
			buf := featureSignal(8000, seconds, func(int) (float32, float32) { return level, level })
			result, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Sections) != 1 || result.Sections[0].Name != "Section 1" || result.Sections[0].RoleHint != "unknown" || result.Sections[0].StartFrame != 0 || result.Sections[0].EndFrame != int64(buf.Frames) {
				t.Fatalf("fabricated or incomplete sections: %+v", result.Sections)
			}
			if len(result.Frames) == 0 {
				t.Fatal("missing feature summary")
			}
			if _, err = json.Marshal(result); err != nil {
				t.Fatal("non-finite JSON", err)
			}
		}
	}
}

func TestFeatureTransitionsAreLocalizedAtMultipleRates(t *testing.T) {
	for _, rate := range []int{8000, 44100, 48000, 96000, 192000} {
		for _, kind := range []string{"energy", "spectrum", "width"} {
			boundary := int(11.73 * float64(rate))
			buf := featureSignal(rate, 24, func(i int) (float32, float32) {
				amplitude, frequency := 0.05, 250.0
				if i >= boundary {
					switch kind {
					case "energy":
						amplitude = 0.2
					case "spectrum":
						frequency = 2500
					}
				}
				value := float32(amplitude * math.Sin(2*math.Pi*frequency*float64(i)/float64(rate)))
				right := value
				if kind == "width" && i >= boundary {
					right = -value
				}
				return value, right
			})
			result, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Sections) != 2 {
				t.Fatalf("rate%d %s sections=%+v", rate, kind, result.Sections)
			}
			actual := result.Sections[1].StartFrame
			if math.Abs(float64(actual-int64(boundary))) > float64(rate)/4 {
				t.Fatalf("rate%d %s transition%g want%g", rate, kind, float64(actual)/float64(rate), float64(boundary)/float64(rate))
			}
			if result.Sections[0].EndFrame != actual || result.Sections[1].EndFrame != int64(buf.Frames) || result.Sections[1].Confidence <= 0 || result.Sections[1].Confidence > 1 {
				t.Fatal("section coverage or confidence invalid")
			}
		}
	}
}

func TestFeatureSourceBindingCancellationAndWindowCadence(t *testing.T) {
	buf := featureSignal(8000, 2, func(int) (float32, float32) { return 0.1, 0.2 })
	first, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Source.PCMHash) != 64 || first.Source != second.Source || len(first.Frames) != 5 {
		t.Fatal("source hash or 1-second/250-ms cadence invalid")
	}
	buf.Right[0] += 0.01
	changed, err := AnalyzeFeaturesContext(context.Background(), buf, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Source.PCMHash == first.Source.PCMHash {
		t.Fatal("PCM change did not invalidate identity")
	}
	buf.SampleRate = 16000
	changed, err = AnalyzeFeaturesContext(context.Background(), buf, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Source.PCMHash == second.Source.PCMHash {
		t.Fatal("sample rate not bound")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = AnalyzeFeaturesContext(ctx, buf, nil); !errors.Is(err, context.Canceled) {
		t.Fatal("pre-canceled context ignored", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	if _, err = AnalyzeFeaturesContext(ctx, buf, func(int, string) { cancel() }); !errors.Is(err, context.Canceled) {
		t.Fatal("in-flight cancellation ignored", err)
	}
}
