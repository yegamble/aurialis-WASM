package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"github.com/yegamble/Aurialis-WASM/internal/audio/automation"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func (s *Server) handleCompileAutomation(w http.ResponseWriter, r *http.Request) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_content_type", "Expected application/json ScriptV2")
		return
	}
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	if queryErr != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", "Malformed compilation query")
		return
	}
	for key, values := range query {
		if key != "deviceRate" || len(values) != 1 {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", "Only one deviceRate query is accepted")
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, mastering.MaxScriptV2Bytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "ScriptV2 exceeds 2 MiB")
		} else {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_script", "Cannot read ScriptV2 JSON")
		}
		return
	}
	if r.Context().Err() != nil {
		writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Schedule compilation canceled")
		return
	}
	script, err := mastering.DecodeScriptV2(data)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_script", err.Error())
		return
	}
	rate := script.Source.SampleRate
	if query.Has("deviceRate") {
		rate, err = strconv.Atoi(query.Get("deviceRate"))
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", "deviceRate must be an integer")
			return
		}
	}
	schedule, err := mastering.ValidateScriptV2Context(r.Context(), script, rate)
	if err != nil {
		if r.Context().Err() != nil {
			writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Schedule compilation canceled")
		} else {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_script", err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": "1.0", "source": script.Source, "revision": script.Revision, "deviceRate": rate, "quantumFrames": schedule.Quantum(), "baseline": script.ChainParams, "moves": schedule.NumericMoves(), "targets": automation.Targets(), "sourceVerified": false})
}
