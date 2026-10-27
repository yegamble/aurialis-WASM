package server

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
)

// TestAPIDocsLimitsMatchConstants fails when docs/api.md states an upload,
// decode, memory or deadline limit that differs from the value /health and
// the handlers actually use.
func TestAPIDocsLimitsMatchConstants(t *testing.T) {
	raw, err := os.ReadFile("../../docs/api.md")
	if err != nil {
		t.Fatalf("read docs/api.md: %v", err)
	}
	doc := string(raw)
	const mib = 1 << 20

	for _, want := range []string{
		fmt.Sprintf("`maxUploadBytes: %d`", DefaultMaxUploadBytes),
		fmt.Sprintf("`maxAudioFileBytes: %d`", MaxAudioFileBytes),
		fmt.Sprintf("**%s bytes**", grouped(MaxAudioFileBytes)),
		fmt.Sprintf("`maxDecodedFrames: %d`", audio.MaxDecodedFrames),
		fmt.Sprintf("**%s frames**", grouped(int64(audio.MaxDecodedFrames))),
		fmt.Sprintf("`jobMemoryBudgetBytes: %d`", jobs.MaxMemoryBytes),
		fmt.Sprintf("within **%d MiB**", jobs.MaxMemoryBytes/mib),
		fmt.Sprintf("at most **%d jobs**", jobs.MaxRetainedJobs),
		fmt.Sprintf("**%d-second** base deadline", int(postRequestTimeout/time.Second)),
		fmt.Sprintf("%d µs per source frame", exportPerSourceFrame/time.Microsecond),
		fmt.Sprintf("%d µs per converted output frame", exportPerConvertedFrame/time.Microsecond),
		fmt.Sprintf("capped at **%d minutes**", int(maxExportBudget/time.Minute)),
		fmt.Sprintf("%d seconds plus 1 second per %d MiB", int(transferFloor/time.Second), transferBytesPerSecond/mib),
		fmt.Sprintf("capped at %d seconds", int(maxTransferTime/time.Second)),
		fmt.Sprintf("%d-minute limit", int(jobs.SeparationTimeout/time.Minute)),
		fmt.Sprintf("%.1f GiB memory pool", float64(jobs.MaxSeparationBytes)/(1<<30)),
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("docs/api.md does not state %q", want)
		}
	}

	// Every restatement of these limits must agree, not just the first.
	for _, c := range []struct {
		re   string
		want int64
	}{
		{`(\d+) MiB including overhead`, DefaultMaxUploadBytes / mib},
		{`(\d+) MiB job budget`, jobs.MaxMemoryBytes / mib},
		{`maxUploadBytes: (\d+)`, DefaultMaxUploadBytes},
		{`jobMemoryBudgetBytes: (\d+)`, jobs.MaxMemoryBytes},
	} {
		matches := regexp.MustCompile(c.re).FindAllStringSubmatch(doc, -1)
		if len(matches) == 0 {
			t.Errorf("docs/api.md has no %q", c.re)
		}
		for _, m := range matches {
			if got, _ := strconv.ParseInt(m[1], 10, 64); got != c.want {
				t.Errorf("docs/api.md %q states %d, want %d", c.re, got, c.want)
			}
		}
	}
}

// grouped formats n with thousands separators, as the docs write large counts.
func grouped(n int64) string {
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
