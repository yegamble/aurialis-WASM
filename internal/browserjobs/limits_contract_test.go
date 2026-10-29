package browserjobs_test

import (
	"go/constant"
	"go/token"
	"go/types"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestTypeScriptAudioLimitsMatchGo(t *testing.T) {
	source, err := os.ReadFile("../../src/lib/audio-limits.ts")
	if err != nil {
		t.Fatal(err)
	}
	declared := map[string]int64{}
	pattern := regexp.MustCompile(`export const (MAX_SOURCE_FRAMES|MAX_SOURCE_BYTES|MAX_JOB_INPUT_BYTES) = ([^;]+);`)
	for _, match := range pattern.FindAllStringSubmatch(string(source), -1) {
		expression := match[2]
		for name, value := range declared {
			expression = strings.ReplaceAll(expression, name, strconv.FormatInt(value, 10))
		}
		result, evalErr := types.Eval(token.NewFileSet(), nil, token.NoPos, expression)
		if evalErr != nil {
			t.Fatal(evalErr)
		}
		value, ok := constant.Int64Val(result.Value)
		if !ok {
			t.Fatalf("%s is not an integer constant", match[1])
		}
		declared[match[1]] = value
	}
	for name, want := range map[string]int64{"MAX_SOURCE_FRAMES": audio.MaxDecodedFrames, "MAX_SOURCE_BYTES": server.MaxAudioFileBytes, "MAX_JOB_INPUT_BYTES": browserjobs.MaxInputBytes} {
		if value, ok := declared[name]; !ok || value != want {
			t.Errorf("TypeScript %s=%d, want Go %d", name, value, want)
		}
	}
}
