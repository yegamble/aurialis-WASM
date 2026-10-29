package server

import (
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
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
		fmt.Sprintf("`processMemoryBudgetBytes: %d`", jobs.MaxProcessMemoryBytes),
		fmt.Sprintf("`modelMemoryAllowanceBytes: %d`", jobs.ModelMemoryAllowance),
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
		{`processMemoryBudgetBytes: (\d+)`, jobs.MaxProcessMemoryBytes},
		{`modelMemoryAllowanceBytes: (\d+)`, jobs.ModelMemoryAllowance},
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

// limitDocs are the user and developer documents that restate runtime limits.
var limitDocs = []string{"docs/api.md", "README.md", "docs/getting-started.md", "docs/architecture.md", "docs/browser-local.md"}

// quantityPattern finds sizes (MiB, GiB) and durations, written as digits or
// small number words, optionally bold or hyphenated ("**60-second**").
var quantityPattern = regexp.MustCompile(`\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\*\*)?[ -](?:\*\*)?(MiB|GiB|minutes?|seconds?|hours?)\b`)

// limitWords mark a quantity as a stated limit rather than a measurement.
var limitWords = regexp.MustCompile(`(?i)request|multipart|maximum|ceiling|budget|upload|expire|retention|retained|timeout|time out|deadline|\bcap\b|capped|limit|at most|pool|cache`)

// TestDocsLimitsEveryMentionMatchesConstants scans every size and duration stated
// next to a limit word in the limit documents. Each one must be claimed by a
// rule below, whose value comes from the Go constant (or, for browser-only
// and deployment limits, the source line) that enforces it, or by an
// allow-listed phrase with a reason. Changing a number, restoring stale
// text, or adding a new limit sentence without a rule all fail.
func TestDocsLimitsEveryMentionMatchesConstants(t *testing.T) {
	const mib = 1 << 20
	minutes := func(d time.Duration) float64 { return d.Seconds() }
	album := sourceNumber(t, "src/components/AurialisWorkstation.tsx", `expectedBytes > (\d+) \* 1024 \* 1024`)
	browserBudgets := sourceNumbers(t, "src/lib/browser-jobs.ts", `return (?:coarse \? )?(\d+) \* MIB(?: : (\d+) \* MIB)?;`)
	browserDeadline := sourceNumber(t, "src/lib/browser-jobs.ts", `return (\d+)_000 \* Math\.max\(1, decoded`)
	compileSignal := sourceNumber(t, "src/lib/deep-mastering.ts", `AbortSignal\.timeout\((\d+)_000\)`)
	qaBuildDeadline := sourceNumber(t, "scripts/serve-e2e.sh", `result = process\.wait\(timeout=(\d+)\)`)
	qaStartDeadline := sourceNumber(t, "scripts/serve-e2e.sh", `deadline=\$\(\(SECONDS \+ (\d+)\)\)`)
	readTimeout := sourceNumber(t, "cmd/aurialis/main.go", `ReadTimeout:\s+(\d+) \* time\.Second`)
	staticFile := sourceNumber(t, "scripts/prepare-browser-assets.mjs", `info\.size > (\d+) \* 1024 \* 1024`)
	assetFile := sourceNumber(t, "scripts/ci-browser-artifacts.py", `MAXIMUM_FILE = (\d+) \* 1024 \* 1024`)
	shard := sourceNumber(t, "scripts/ci-browser-artifacts.py", `MAXIMUM_MODEL_SHARD = (\d+) \* 1024 \* 1024`)
	assetMetadata := sourceNumber(t, "scripts/ci-browser-artifacts.py", `MAXIMUM_METADATA = (\d+) \* 1024 \* 1024`)
	nativePackage := sourceNumber(t, "scripts/ci-artifacts.py", `MAXIMUM_BYTES = (\d+) \* 1024 \* 1024`)
	referenceHeadroom := sourceNumber(t, "internal/jobs/reference.go", `reference\.Frames\)\*8 \+ (\d+)\*1024\*1024`)
	if len(browserBudgets) != 5 {
		t.Fatalf("src/lib/browser-jobs.ts memoryBudget: found %v, want five budgets", browserBudgets)
	}

	request := float64(DefaultMaxUploadBytes)
	file := float64(MaxAudioFileBytes - 44) // stated as "<n> MiB plus 44 bytes"
	budget := float64(jobs.MaxMemoryBytes)
	legacyFile := sourceNumber(t, "src/lib/legacy-library.ts", `MAX_FILE_BYTES = (\d+) \* 1024 \* 1024 \+ 44`) * mib
	rules := []struct {
		re   string
		want float64 // bytes or seconds
	}{
		// Native request cap (server.DefaultMaxUploadBytes) and the equal browser input cap.
		{`\*\*(\d+ MiB) including overhead`, request},
		{`share(?:s the existing| one| the)? \*{0,2}(\d+ MiB)\*{0,2} (?:multipart )?(?:request ceiling|maximum)`, request},
		{`combined (\d+ MiB) request cap`, request},
		{`hard (\d+ MiB) cap`, request},
		{`permits (\d+ MiB) combined binary input`, float64(browserjobs.MaxInputBytes)},
		{`binary-input limit is (\d+ MiB)`, float64(browserjobs.MaxInputBytes)},
		// File cap (MaxAudioFileBytes); the session cache equals it (src/lib/db.ts MAX_SESSION_BYTES).
		{`At most \*\*(\d+ MiB) \+ 44 bytes`, file},
		{`file cap is \*\*(\d+ MiB) plus a 44-byte`, file},
		{`allowing (\d+ MiB) of stereo-float samples`, file},
		{`audio files a (\d+ MiB) plus canonical-header cap`, file},
		{`within the (\d+ MiB) plus 44-byte`, file},
		{`cache capped at (\d+ MiB) plus 44 bytes`, file},
		{`total cache cap of \*\*(\d+ MiB) plus 44 bytes`, file},
		{`Recovery is capped at (\d+ MiB)`, legacyFile},
		{`Each saved original is limited to (\d+ MiB)`, legacyFile},
		// Job memory budget (jobs.MaxMemoryBytes).
		{`(\d+ MiB) job budget`, budget},
		{`within \*\*(\d+ MiB)\*\*`, budget},
		{`jobMemoryBudgetBytes: \d+` + "`" + ` \((\d+ MiB)\)`, budget},
		{`reservations are bounded at (\d+ MiB)`, budget},
		{`(\d+ MiB) normal-job`, budget},
		{`(\d+(?:\.\d+)? GiB) working-allocation budget`, float64(jobs.MaxProcessMemoryBytes)},
		{`(\d+(?:\.\d+)? GiB) (?:separation|stem) limits`, float64(jobs.MaxSeparationBytes)},
		{`(\d+-minute) process-tree deadline`, qaBuildDeadline},
		{`(\d+-second) server-start check`, qaStartDeadline},
		{`reference\.frames × 8 \+ (\d+ MiB)`, referenceHeadroom * mib},
		{`retained scripts are charged at (\d+ MiB)`, mastering.MaxScriptV2Bytes},
		// Separation pool and deadline (jobs.MaxSeparationBytes, jobs.SeparationTimeout).
		{`(\d+(?:\.\d+)? GiB) memory pool`, float64(jobs.MaxSeparationBytes)},
		{`its own (\d+(?:\.\d+)? GiB) pool`, float64(jobs.MaxSeparationBytes)},
		{`pass the (\d+(?:\.\d+)? GiB) job ceiling`, float64(jobs.MaxSeparationBytes)},
		{`(\d+-minute) (?:job )?limit`, minutes(jobs.SeparationTimeout)},
		// Retention (jobs.Retention) and the worker timeout (jobs.WorkerTimeout).
		{`expire after (\d+ minutes)`, minutes(jobs.Retention)},
		{`retained like other job results \((\d+ minutes)\)`, minutes(jobs.Retention)},
		{`Worker timeout is (\w+ minutes)`, minutes(jobs.WorkerTimeout)},
		{`Jobs time out after (\w+ minutes)`, minutes(jobs.WorkerTimeout)},
		{`(\w+-minute) worker timeout`, minutes(jobs.WorkerTimeout)},
		// Request deadlines (deadline.go) and the server read timeout (cmd/aurialis).
		{`\*\*(\d+-second)\*\* base deadline`, postRequestTimeout.Seconds()},
		{`outlasts the (\d+-second) base deadline`, postRequestTimeout.Seconds()},
		{`admission slot and (\d+-second) request timeout`, postRequestTimeout.Seconds()},
		{`measured from that point: (\d+ seconds)`, postRequestTimeout.Seconds()},
		{`capped at \*\*(\d+ minutes)\*\*`, maxExportBudget.Seconds()},
		{`up to (\d+ minutes) \(its export budget ceiling\)`, maxExportBudget.Seconds()},
		{`(?:read deadline of|body then gets) (\d+ seconds) plus`, transferFloor.Seconds()},
		{`plus (\w+ second) per \d+ MiB`, 1},
		{`second per (\d+ MiB)`, transferBytesPerSecond},
		{`Content-Length` + "`" + `, capped at (\d+ seconds)`, maxTransferTime.Seconds()},
		{`server's (\d+-second) read timeout`, readTimeout},
		// Browser-only limits (src/lib, internal/browserjobs).
		{`(\d+ seconds) per 16,777,216 decoded frames`, browserDeadline},
		{`at least (\d+ seconds)`, browserDeadline},
		{`(\d+-second) client deadline`, browserDeadline},
		{`caller’s (\d+-second) signal`, compileSignal},
		{`(\d+ MiB) plus 128 KiB`, float64(browserjobs.MaxMetadataBytes - 128*1024)},
		{`JSON is capped at (\d+ MiB)`, mastering.MaxScriptV2Bytes},
		{`ScriptV2, up to (\d+ MiB)`, mastering.MaxScriptV2Bytes},
		{`\*{0,2}(\d+ MiB) in-memory (?:session )?cache`, album * mib},
		{`budget is (\d+ MiB) on devices reporting at most 2 GB`, browserBudgets[0] * mib},
		{`(\d+ GiB) on devices reporting at least 8 GB`, browserBudgets[1] * mib},
		{`(\d+ MiB) on devices reporting 4 GB`, browserBudgets[2] * mib},
		{`(\d+(?:\.\d+)? GiB) with a coarse pointer`, browserBudgets[3] * mib},
		{`pointer and (\d+(?:\.\d+)? GiB) otherwise`, browserBudgets[4] * mib},
		// Deployment artifact limits (scripts/).
		{`static-file limit is (\d+ MiB)`, staticFile * mib},
		{`assets are at most (\d+ MiB)`, assetFile * mib},
		{`(?:shards (?:at most|no larger than)|hash-verified and at most) (\d+ MiB)`, shard * mib},
		{`metadata at most (\d+ MiB)`, assetMetadata * mib},
		{`package at most (\d+ MiB)`, nativePackage * mib},
	}
	// Quantities beside a limit word that are not limits, each with a reason.
	const ci = "CI workflow step bound in .github/workflows/ci.yml, not a product limit"
	allowed := []struct{ phrase, reason string }{
		{"OS provisioning to five minutes and a cache-miss browser download to four minutes", ci},
		{"30-second HTTP/HTTPS timeouts", ci},
		{"its own three-minute limit", ci},
		{"separate three-minute limit", ci},
		{"a five-minute step limit", ci},
		{"separate four-minute download limit", ci},
		{"five-minute actual-song", "length of the recorded test song"},
		{"Isolated 3/5-minute native render", "lengths of the measured test songs"},
	}

	used := make([]bool, len(rules))
	for _, name := range limitDocs {
		doc := readRepo(t, name)
		claimed := map[int]bool{}
		for i, r := range rules {
			for _, m := range regexp.MustCompile(r.re).FindAllStringSubmatchIndex(doc, -1) {
				used[i] = true
				text := doc[m[2]:m[3]]
				claimed[m[2]] = true
				if got, ok := quantity(text); !ok || got != r.want {
					t.Errorf("%s:%d states %q (rule %q), want %s", name, line(doc, m[2]), text, r.re, describe(r.want, text))
				}
			}
		}
		for _, a := range allowed {
			for i := strings.Index(doc, a.phrase); i >= 0; {
				for _, m := range quantityPattern.FindAllStringIndex(a.phrase, -1) {
					claimed[i+m[0]] = true
				}
				next := strings.Index(doc[i+1:], a.phrase)
				if next < 0 {
					break
				}
				i += 1 + next
			}
		}
		for _, m := range quantityPattern.FindAllStringIndex(doc, -1) {
			if claimed[m[0]] || !limitWords.MatchString(clause(doc, m[0], m[1])) {
				continue
			}
			t.Errorf("%s:%d: %q is stated beside a limit word but no rule checks it: %q", name, line(doc, m[0]), doc[m[0]:m[1]], clause(doc, m[0], m[1]))
		}
	}
	for i, r := range rules {
		if !used[i] {
			t.Errorf("rule %q matches no document; remove or update it", r.re)
		}
	}
	for _, a := range allowed {
		found := false
		for _, name := range limitDocs {
			found = found || strings.Contains(readRepo(t, name), a.phrase)
		}
		if !found {
			t.Errorf("allow-list phrase %q (%s) no longer appears; remove it", a.phrase, a.reason)
		}
	}
}

var numberWords = map[string]float64{"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}

// quantity converts "257 MiB", "1.5 GiB", "two minutes" or "60-second" to
// bytes or seconds.
func quantity(text string) (float64, bool) {
	m := quantityPattern.FindStringSubmatch(text)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		var ok bool
		if n, ok = numberWords[m[1]]; !ok {
			return 0, false
		}
	}
	switch strings.TrimSuffix(m[2], "s") {
	case "MiB":
		return n * (1 << 20), true
	case "GiB":
		return n * (1 << 30), true
	case "second":
		return n, true
	case "minute":
		return n * 60, true
	case "hour":
		return n * 3600, true
	}
	return 0, false
}

// describe renders a wanted value in the unit family of the stated text.
func describe(want float64, text string) string {
	if strings.Contains(text, "iB") {
		return strconv.FormatFloat(want/(1<<20), 'f', -1, 64) + " MiB"
	}
	return strconv.FormatFloat(want, 'f', -1, 64) + " seconds"
}

// clause returns the text around a match, up to 80 bytes before and 50 after,
// cut at sentence, list and table boundaries.
func clause(doc string, start, end int) string {
	before, after := doc[max(0, start-80):start], doc[end:min(len(doc), end+50)]
	for _, sep := range []string{". ", "; ", "|", "\n", "("} {
		if i := strings.LastIndex(before, sep); i >= 0 {
			before = before[i+len(sep):]
		}
		if i := strings.Index(after, sep); i >= 0 {
			after = after[:i]
		}
	}
	return before + doc[start:end] + after
}

func line(doc string, offset int) int { return strings.Count(doc[:offset], "\n") + 1 }

// sourceNumbers returns every number captured by re in a repository file.
func sourceNumbers(t *testing.T, path, re string) []float64 {
	t.Helper()
	var out []float64
	for _, m := range regexp.MustCompile(re).FindAllStringSubmatch(readRepo(t, path), -1) {
		for _, g := range m[1:] {
			if g == "" {
				continue
			}
			n, err := strconv.ParseFloat(g, 64)
			if err != nil {
				t.Fatalf("%s: %q: %v", path, g, err)
			}
			out = append(out, n)
		}
	}
	return out
}

// sourceNumber returns the single number captured by re in a repository file.
func sourceNumber(t *testing.T, path, re string) float64 {
	t.Helper()
	got := sourceNumbers(t, path, re)
	if len(got) == 0 {
		t.Fatalf("%s no longer matches %q; update the docs limit rule", path, re)
	}
	for _, n := range got[1:] {
		if n != got[0] {
			t.Fatalf("%s: %q matches differing values %v", path, re, got)
		}
	}
	return got[0]
}

// readRepo reads a file by its repository-relative path.
func readRepo(t *testing.T, name string) string {
	t.Helper()
	raw, err := fs.ReadFile(os.DirFS("../.."), name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}
