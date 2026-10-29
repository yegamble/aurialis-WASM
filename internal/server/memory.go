package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
)

type requestMemoryKey struct{}

func requestMemory(r *http.Request) *jobs.MemoryReservation {
	reservation, _ := r.Context().Value(requestMemoryKey{}).(*jobs.MemoryReservation)
	return reservation
}
func pcmCapacity(buf *audio.Buffer) int64 { return int64(cap(buf.Left)+cap(buf.Right)) * 4 }
func (s *Server) uploadMemoryBytes() int64 {
	// ReadAll may grow/copy its raw backing array. FLAC output growth can hold
	// old plus new PCM backing arrays. Reserve before reading unknown geometry.
	return 2*s.cfg.MaxUploadBytes + 3*int64(audio.MaxDecodedFrames)*8 + 32*1024*1024
}
func (s *Server) reserveRequest(w http.ResponseWriter, r *http.Request) (*http.Request, *jobs.MemoryReservation, bool) {
	bytes := s.uploadMemoryBytes()
	if r.URL.Path == "/api/automation/compile" {
		bytes = 32 * 1024 * 1024
	}
	reservation, err := s.jobs.ReserveMemory(bytes)
	if err != nil {
		writeMemoryCapacity(w)
		return r, nil, false
	}
	return r.WithContext(context.WithValue(r.Context(), requestMemoryKey{}, reservation)), reservation, true
}
func resizeRequest(w http.ResponseWriter, r *http.Request, bytes int64) bool {
	reservation := requestMemory(r)
	if reservation != nil {
		if err := reservation.Resize(bytes); err != nil {
			writeMemoryCapacity(w)
			return false
		}
	}
	return true
}
func writeMemoryCapacity(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeErrorJSON(w, http.StatusServiceUnavailable, "memory_capacity", jobs.ErrMemoryCapacity.Error())
}
func renderMemoryBytes(buf *audio.Buffer, outputRate int) int64 {
	bytes := pcmCapacity(buf) + int64(buf.Frames)*16 + 64*1024*1024
	if outputRate != buf.SampleRate {
		frames := (int64(buf.Frames)*int64(outputRate) + int64(buf.SampleRate) - 1) / int64(buf.SampleRate)
		// Converted channels, converter scratch and delivered float WAV.
		bytes += frames * 24
	} else {
		bytes += int64(buf.Frames)*8 + 44
	}
	return bytes
}

func writeAdmissionError(w http.ResponseWriter, err error) {
	if errors.Is(err, jobs.ErrMemoryCapacity) {
		writeMemoryCapacity(w)
		return
	}
	writeErrorJSON(w, http.StatusServiceUnavailable, "queue_full", err.Error())
}
