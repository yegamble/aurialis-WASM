package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestMasterRenderNamesMistypedArrayField(t *testing.T) {
	params := dsp.DefaultParams()
	raw, err := json.Marshal(params.Bands)
	if err != nil {
		t.Fatal(err)
	}
	var bands []map[string]any
	if err = json.Unmarshal(raw, &bands); err != nil {
		t.Fatal(err)
	}
	bands[0]["gainDb"] = "private-request-text"
	body, err := json.Marshal(map[string]any{"bands": bands})
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(server.Config{Workers: 1})
	defer srv.Close()
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, newMultipartRequest(t, http.MethodPost, "/api/master/render", "source.wav", buildTestWAV(t, 8000, .01), map[string]string{"params": string(body)}))
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "bands.gainDb must be a number") || strings.Contains(rec.Body.String(), "private-request-text") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
