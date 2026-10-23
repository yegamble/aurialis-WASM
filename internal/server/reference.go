package server

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

type referenceRequest struct {
	source, reference *audio.Buffer
	baseline          dsp.Params
	options           mastering.ReferenceOptions
}

func (s *Server) handleAnalyzeReference(w http.ResponseWriter, r *http.Request) {
	request, ok := s.readReferenceUpload(w, r)
	if !ok {
		return
	}
	if r.Context().Err() != nil {
		return
	}
	job, err := s.jobs.SubmitAnalyzeReference(request.source, request.reference, request.baseline, request.options)
	if err != nil {
		writeErrorJSON(w, http.StatusServiceUnavailable, "queue_full", err.Error())
		return
	}
	s.writeAdmittedJob(w, r, job)
}

// Both audio parts pass the existing in-memory CDR. The request ceiling is shared
// by the complete multipart body; adding a reference does not double upload limits.
func (s *Server) readReferenceUpload(w http.ResponseWriter, r *http.Request) (*referenceRequest, bool) {
	if r.URL.RawQuery != "" {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", "Reference options belong in the bounded multipart fields")
		return nil, false
	}
	if r.ContentLength > s.cfg.MaxUploadBytes {
		writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Combined reference upload exceeds request limit")
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Expected multipart/form-data")
		return nil, false
	}
	request := &referenceRequest{baseline: dsp.DefaultParams(), options: mastering.ReferenceOptions{Amount: .5, ProtectBelowHz: 120}}
	seen := make(map[string]bool, 4)
	for count := 0; ; count++ {
		part, partErr := reader.NextRawPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			uploadReadError(w, partErr)
			return nil, false
		}
		if count >= 4 {
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Too many reference fields")
			return nil, false
		}
		_, disposition, parseErr := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		name := disposition["name"]
		if parseErr != nil || seen[name] {
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Invalid or duplicate reference field")
			return nil, false
		}
		seen[name] = true
		filename := disposition["filename"]
		switch {
		case (name == "source" || name == "reference") && filename != "":
			if _, parseErr = audio.SanitizeFilename(filename); parseErr != nil {
				_ = part.Close()
				writeErrorJSON(w, http.StatusBadRequest, "invalid_audio", "Invalid audio filename")
				return nil, false
			}
			raw, readErr := io.ReadAll(io.LimitReader(part, MaxAudioFileBytes+1))
			_ = part.Close()
			if readErr != nil {
				uploadReadError(w, readErr)
				return nil, false
			}
			if int64(len(raw)) > MaxAudioFileBytes {
				writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Reference audio exceeds frame storage capacity")
				return nil, false
			}
			decoded, decodeErr := audio.DecodeAndDisarm(filename, raw)
			if decodeErr != nil {
				writeErrorJSON(w, http.StatusBadRequest, "invalid_audio", fmt.Sprintf("%s audio: %s", name, decodeErr.Error()))
				return nil, false
			}
			if name == "source" {
				request.source = decoded
			} else {
				request.reference = decoded
			}
		case (name == "params" || name == "options") && filename == "":
			limit := int64(64 * 1024)
			if name == "options" {
				limit = 2048
			}
			raw, readErr := io.ReadAll(io.LimitReader(part, limit+1))
			_ = part.Close()
			if readErr != nil {
				uploadReadError(w, readErr)
				return nil, false
			}
			if int64(len(raw)) > limit {
				writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Reference metadata exceeds its field limit")
				return nil, false
			}
			var decodeErr error
			if name == "options" {
				request.options, decodeErr = mastering.DecodeReferenceOptionsJSON(raw)
			} else {
				request.baseline, decodeErr = dsp.DecodeParamsJSON(raw, request.baseline)
			}
			if decodeErr != nil {
				writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", decodeErr.Error())
				return nil, false
			}
		default:
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Unknown reference field or invalid file disposition")
			return nil, false
		}
		if r.Context().Err() != nil {
			writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Reference request canceled")
			return nil, false
		}
	}
	if request.source == nil || request.reference == nil {
		writeErrorJSON(w, http.StatusBadRequest, "missing_file", "source and reference audio parts are required")
		return nil, false
	}
	return request, true
}
