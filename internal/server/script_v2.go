package server

import (
	"encoding/json"
	"net/http"

	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

func readRenderScriptV2(w http.ResponseWriter, r *http.Request) (*mastering.ScriptV2, bool) {
	raw, hasScript := r.Form["script"]
	if !hasScript {
		return nil, true
	}
	if _, hasParams := r.Form["params"]; hasParams {
		writeErrorJSON(w, http.StatusBadRequest, "conflicting_parameters", "script is mutually exclusive with params and profile")
		return nil, false
	}
	if _, hasProfile := r.Form["profile"]; hasProfile {
		writeErrorJSON(w, http.StatusBadRequest, "conflicting_parameters", "script is mutually exclusive with params and profile")
		return nil, false
	}
	if r.URL.Query().Has("params") || r.URL.Query().Has("profile") {
		writeErrorJSON(w, http.StatusBadRequest, "conflicting_parameters", "script is mutually exclusive with params and profile")
		return nil, false
	}
	script, err := mastering.DecodeScriptV2([]byte(raw[0]))
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_script", err.Error())
		return nil, false
	}
	return script, true
}

func (s *Server) writeAdmittedJob(w http.ResponseWriter, r *http.Request, job *jobs.Job) {
	if r.Context().Err() != nil {
		s.jobs.Cancel(job.ID)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusAccepted)
	if err := json.NewEncoder(w).Encode(job); err != nil {
		s.jobs.Cancel(job.ID)
	}
}
