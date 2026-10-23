package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func apiScript(t *testing.T, wav []byte) mastering.ScriptV2 {
	t.Helper()
	buf, err := audio.DecodeAndDisarm("source.wav", wav)
	if err != nil {
		t.Fatal(err)
	}
	source, err := mastering.SourceIdentityContext(context.Background(), buf)
	if err != nil {
		t.Fatal(err)
	}
	return mastering.ScriptV2{Version: "2.0", Source: source, Revision: 1, Profile: mastering.ProfileDynamicOpen, Summary: "API fixture", ChainParams: dsp.DefaultParams(), Sections: []mastering.FeatureSection{{ID: "section-1", Name: "Section 1", EndFrame: source.Frames, RoleHint: "unknown"}}, Moves: []automation.Move{}, Findings: []mastering.Finding{}}
}
func encodedScript(t *testing.T, script mastering.ScriptV2) string {
	t.Helper()
	data, err := json.Marshal(script)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func TestScriptV2APIExactRenderAndRejectedContracts(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	script := apiScript(t, wav)
	valid := encodedScript(t, script)
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"script": valid, "bitDepth": "32"}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid script render %d: %s", recorder.Code, recorder.Body.String())
	}
	decoded, err := audio.DecodeAndDisarm("render.wav", recorder.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	source, err := mastering.SourceIdentityContext(context.Background(), decoded)
	if err != nil || source != script.Source {
		t.Fatal("empty schedule changed canonical source PCM", err)
	}
	for _, fields := range []map[string]string{
		{"script": valid, "params": ""}, {"script": valid, "profile": ""}, {"script": "{}"}, {"script": strings.Replace(valid, script.Source.PCMHash, strings.Repeat("0", 64), 1)},
		{"script": strings.Replace(valid, `"version":"2.0"`, `"version":"1.0"`, 1)},
		{"script": strings.Replace(valid, `"moves":[]`, `"moves":null`, 1)},
	} {
		recorder = httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, fields))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("invalid script %d: %s", recorder.Code, recorder.Body.String())
		}
	}
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", wav, map[string]string{"script": strings.Repeat(" ", mastering.MaxScriptV2Bytes+1)}))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatal("oversized script accepted", recorder.Code)
	}
}
func TestScriptV2AnalysisAPIAndFailedDeliveryCancellation(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/analyze/deep", "source.wav", wav, map[string]string{"scriptVersion": "2.0", "profile": "Dynamic & Open"}))
	if recorder.Code != http.StatusAccepted {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
	var submitted jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+submitted.ID+"?wait=1", nil)
	request.Host = "127.0.0.1:8080"
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, request)
	var result jobs.Job
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != jobs.StatusDone || result.Kind != jobs.KindAnalyzeDeepV2 || result.ScriptV2 == nil || result.Script != nil || result.ScriptV2.Version != "2.0" {
		t.Fatal("invalid v2 job result", recorder.Body.String())
	}
	if _, err := mastering.ValidateScriptV2Context(context.Background(), result.ScriptV2, 8000); err != nil {
		t.Fatal(err)
	}
	for _, fields := range []map[string]string{{"scriptVersion": "9"}, {"scriptVersion": "2.0", "params": "{}"}} {
		recorder = httptest.NewRecorder()
		srv.Handler().ServeHTTP(recorder, newMultipartRequest(t, http.MethodPost, "/api/analyze/deep", "source.wav", wav, fields))
		if recorder.Code != http.StatusBadRequest {
			t.Fatal("unsupported v2 option accepted")
		}
	}
	recorder = httptest.NewRecorder()
	writer := failedFeatureDelivery{ResponseRecorder: recorder}
	srv.Handler().ServeHTTP(writer, newMultipartRequest(t, http.MethodPost, "/api/analyze/deep", "source.wav", wav, map[string]string{"scriptVersion": "2.0"}))
	if err := json.Unmarshal(recorder.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/jobs/"+submitted.ID, nil)
	request.Host = "127.0.0.1:8080"
	recorder = httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, request)
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != jobs.StatusCanceled {
		t.Fatal("delivery failure orphaned admitted v2 job")
	}
}

func TestScriptV2CompileAPIProducesUnverifiedNumericPacket(t *testing.T) {
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	wav := buildTestWAV(t, 8000, .25)
	script := apiScript(t, wav)
	script.Moves = []automation.Move{{ID: "gain", SectionID: "section-1", Reason: "fixture", Target: "inputGainDb", Operation: "add", Points: []automation.Point{{Frame: 0, Value: 0}, {Frame: script.Source.Frames, Value: 1}}}}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/automation/compile?deviceRate=44100", strings.NewReader(encodedScript(t, script)))
	request.Host = "127.0.0.1:8080"
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
	var packet struct {
		Version        string                   `json:"version"`
		Source         mastering.SourceIdentity `json:"source"`
		DeviceRate     int                      `json:"deviceRate"`
		QuantumFrames  int                      `json:"quantumFrames"`
		SourceVerified bool                     `json:"sourceVerified"`
		Moves          []automation.NumericMove `json:"moves"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &packet); err != nil {
		t.Fatal(err)
	}
	if packet.Version != "1.0" || packet.Source != script.Source || packet.DeviceRate != 44100 || packet.QuantumFrames != 44 || packet.SourceVerified || len(packet.Moves) != 1 || packet.Moves[0].Target != automation.InputGain {
		t.Fatal("compile packet contract mismatch", recorder.Body.String())
	}
}
