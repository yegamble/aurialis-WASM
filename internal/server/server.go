// Package server implements the hardened HTTP/JSON API, Audio CDR upload handler,
// COOP/COEP WebAssembly isolation middleware, and embedded Next.js 16 static server.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// DefaultMaxUploadBytes is the default 200 MB upload ceiling.
const DefaultMaxUploadBytes int64 = 200 * 1024 * 1024

// Config configures the Aurialis HTTP server.
type Config struct {
	MaxUploadBytes int64
	Workers        int
	StaticFS       fs.FS
	WasmFS         fs.FS
}

// Server serves the Aurialis HTTP API and embedded Next.js + WASM assets.
type Server struct {
	cfg     Config
	jobs    *jobs.Manager
	handler http.Handler
}

// New constructs a new Aurialis HTTP server and starts the worker pool.
func New(cfg Config) *Server {
	if cfg.MaxUploadBytes <= 0 {
		cfg.MaxUploadBytes = DefaultMaxUploadBytes
		if envVal := strings.TrimSpace(os.Getenv("MAX_UPLOAD_BYTES_OVERRIDE")); envVal != "" {
			if parsed, err := strconv.ParseInt(envVal, 10, 64); err == nil && parsed > 0 {
				cfg.MaxUploadBytes = parsed
			}
		}
	}

	s := &Server{
		cfg:  cfg,
		jobs: jobs.NewManager(cfg.Workers),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /api/health", s.handleHealth)

	mux.HandleFunc("POST /separate", s.handleSeparate)
	mux.HandleFunc("POST /api/separate", s.handleSeparate)

	mux.HandleFunc("POST /analyze/deep", s.handleAnalyzeDeep)
	mux.HandleFunc("POST /api/analyze/deep", s.handleAnalyzeDeep)

	mux.HandleFunc("POST /api/master/render", s.handleMasterRender)
	mux.HandleFunc("POST /master/render", s.handleMasterRender)

	mux.HandleFunc("GET /jobs/{id}", s.handleGetJob)
	mux.HandleFunc("GET /jobs/{id}/status", s.handleGetJob)
	mux.HandleFunc("GET /jobs/{id}/result", s.handleGetJob)
	mux.HandleFunc("GET /api/jobs/{id}", s.handleGetJob)
	mux.HandleFunc("GET /api/jobs/{id}/status", s.handleGetJob)
	mux.HandleFunc("GET /api/jobs/{id}/result", s.handleGetJob)

	mux.HandleFunc("DELETE /jobs/{id}", s.handleCancelJob)
	mux.HandleFunc("DELETE /api/jobs/{id}", s.handleCancelJob)

	mux.HandleFunc("GET /jobs/{id}/stems/{stemName}", s.handleDownloadStem)
	mux.HandleFunc("GET /api/jobs/{id}/stems/{stemName}", s.handleDownloadStem)

	mux.HandleFunc("/", s.handleStaticOrSPA)

	s.handler = s.securityMiddleware(mux)
	return s
}

// Handler returns the root http.Handler with all security middlewares attached.
func (s *Server) Handler() http.Handler {
	return s.handler
}

// Close shuts down the background job manager cleanly.
func (s *Server) Close() {
	s.jobs.Close()
}

func (s *Server) securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mandatory COOP/COEP/CORP & security headers for SharedArrayBuffer + AudioWorklet + host protection
		h := w.Header()
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")

		// 1. Validate Host header against DNS rebinding attacks
		if !isAllowedLocalHost(r.Host) {
			writeErrorJSON(w, http.StatusForbidden, "forbidden_host", "Requests with non-local Host headers are rejected")
			return
		}

		// 2. Validate Origin and Sec-Fetch-Site on state-changing methods against drive-by localhost CSRF
		if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete {
			if secSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); secSite == "cross-site" {
				writeErrorJSON(w, http.StatusForbidden, "csrf_rejected", "Cross-site state-changing requests are forbidden")
				return
			}
			if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && origin != "null" {
				u, err := url.Parse(origin)
				if err != nil || !isAllowedLocalHost(u.Host) {
					writeErrorJSON(w, http.StatusForbidden, "forbidden_origin", "Cross-origin state-changing requests are forbidden")
					return
				}
			}
		}

		next.ServeHTTP(w, r)
	})
}

func isAllowedLocalHost(hostport string) bool {
	trimmed := strings.TrimSpace(hostport)
	if trimmed == "" {
		return true
	}
	host := trimmed
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	switch host {
	case "127.0.0.1", "localhost", "::1", "0.0.0.0":
		return true
	default:
		return false
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeErrorJSON(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]any{
		"error":  code,
		"detail": detail,
		"status": status,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"service":      "aurialis-wasm",
		"version":      "0.1.0",
		"wasmDsp":      true,
		"wasmDspReady": true,
		"gpu":          false,
		"models":       []string{"htdemucs", "2", "3", "4", "5", "6"},
		"profiles": []string{
			"Warm Analog",
			"Punchy Commercial",
			"Dynamic & Open",
			"Vocal Forward",
			"Bass Heavy",
			"modern_pop_polish",
			"hip_hop_low_end",
			"indie_warmth",
			"metal_wall",
			"pop_punk_air",
		},
	})
}

func (s *Server) readAndDisarmUpload(w http.ResponseWriter, r *http.Request) (*audio.Buffer, bool) {
	if r.ContentLength > s.cfg.MaxUploadBytes {
		writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large",
			fmt.Sprintf("Upload exceeds maximum size of %d bytes", s.cfg.MaxUploadBytes))
		return nil, false
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes)
	if err := r.ParseMultipartForm(16 * 1024 * 1024); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) || strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large",
				fmt.Sprintf("Upload exceeds maximum size of %d bytes", s.cfg.MaxUploadBytes))
			return nil, false
		}
		writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Expected multipart/form-data upload with audio file")
		return nil, false
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "missing_file", "Form field 'file' is required")
		return nil, false
	}
	defer func() {
		_ = file.Close()
	}()

	rawBytes, err := io.ReadAll(file)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Uploaded file exceeds size limit")
			return nil, false
		}
		writeErrorJSON(w, http.StatusBadRequest, "read_error", "Failed to read uploaded file stream")
		return nil, false
	}

	buf, err := audio.DecodeAndDisarm(header.Filename, rawBytes)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_audio", err.Error())
		return nil, false
	}
	return buf, true
}

func parseStemCountAndModel(r *http.Request) (int, error) {
	rawStems := strings.TrimSpace(r.FormValue("stems"))
	if rawStems == "" {
		rawStems = strings.TrimSpace(r.URL.Query().Get("stems"))
	}
	rawModel := strings.TrimSpace(r.FormValue("model"))
	if rawModel == "" {
		rawModel = strings.TrimSpace(r.URL.Query().Get("model"))
	}

	if rawModel != "" {
		lowerModel := strings.ToLower(rawModel)
		switch lowerModel {
		case "htdemucs", "htdemucs_ft", "default", "standard":
			if rawStems == "" {
				return 4, nil
			}
		case "htdemucs_6s":
			if rawStems == "" {
				return 6, nil
			}
		case "2", "3", "4", "5", "6":
			if rawStems == "" {
				rawStems = lowerModel
			}
		default:
			return 0, fmt.Errorf("unsupported stem separation model %q", rawModel)
		}
	}

	if rawStems == "" {
		return 4, nil
	}
	n, err := strconv.Atoi(rawStems)
	if err != nil || n < 2 || n > 6 {
		return 0, fmt.Errorf("stems parameter must be an integer between 2 and 6 (got %q)", rawStems)
	}
	return n, nil
}

func (s *Server) handleSeparate(w http.ResponseWriter, r *http.Request) {
	buf, ok := s.readAndDisarmUpload(w, r)
	if !ok {
		return
	}
	stemCount, err := parseStemCountAndModel(r)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_parameter", err.Error())
		return
	}

	job, err := s.jobs.SubmitSeparate(buf, stemCount)
	if err != nil {
		writeErrorJSON(w, http.StatusServiceUnavailable, "queue_full", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleAnalyzeDeep(w http.ResponseWriter, r *http.Request) {
	buf, ok := s.readAndDisarmUpload(w, r)
	if !ok {
		return
	}
	rawProfile := strings.TrimSpace(r.FormValue("profile"))
	if rawProfile == "" {
		rawProfile = strings.TrimSpace(r.URL.Query().Get("profile"))
	}
	profile, err := mastering.NormalizeProfile(rawProfile)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_profile", err.Error())
		return
	}

	job, err := s.jobs.SubmitAnalyzeDeep(buf, profile)
	if err != nil {
		writeErrorJSON(w, http.StatusServiceUnavailable, "queue_full", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleMasterRender(w http.ResponseWriter, r *http.Request) {
	buf, ok := s.readAndDisarmUpload(w, r)
	if !ok {
		return
	}

	params := dsp.DefaultParams()
	if rawProf := strings.TrimSpace(r.FormValue("profile")); rawProf != "" {
		prof, err := mastering.NormalizeProfile(rawProf)
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_profile", err.Error())
			return
		}
		params = mastering.ProfilePreset(prof)
	}
	if rawParams := strings.TrimSpace(r.FormValue("params")); rawParams != "" {
		if err := json.Unmarshal([]byte(rawParams), &params); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_params", "Invalid DSP params JSON: "+err.Error())
			return
		}
	}

	bitDepth := 24
	if rawBits := strings.TrimSpace(r.FormValue("bitDepth")); rawBits != "" {
		if parsed, err := strconv.Atoi(rawBits); err == nil && (parsed == 16 || parsed == 24 || parsed == 32) {
			bitDepth = parsed
		}
	}
	if bitDepth == 16 || bitDepth == 24 {
		params.DitherBits = bitDepth
	}

	beforeMetrics := dsp.MeasureStereo(buf.Left, buf.Right, float64(buf.SampleRate))
	outL, outR, afterMetrics := dsp.RenderBuffer(buf.Left, buf.Right, float64(buf.SampleRate), params)

	if r.FormValue("format") == "json" || strings.Contains(r.Header.Get("Accept"), "application/json") {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "ok",
			"sampleRate":    buf.SampleRate,
			"frames":        buf.Frames,
			"duration":      buf.Duration,
			"bitDepth":      bitDepth,
			"params":        params,
			"beforeMetrics": beforeMetrics,
			"afterMetrics":  afterMetrics,
		})
		return
	}

	wavBytes, err := audio.EncodeWAV(outL, outR, buf.SampleRate, bitDepth)
	if err != nil {
		writeErrorJSON(w, http.StatusInternalServerError, "encode_error", err.Error())
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Disposition", `attachment; filename="aurialis-mastered.wav"`)
	w.Header().Set("X-Aurialis-Before-LUFS", fmt.Sprintf("%.2f", beforeMetrics.IntegratedLUFS))
	w.Header().Set("X-Aurialis-After-LUFS", fmt.Sprintf("%.2f", afterMetrics.IntegratedLUFS))
	w.Header().Set("X-Aurialis-After-Peak-dBTP", fmt.Sprintf("%.2f", afterMetrics.TruePeakDBTP))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wavBytes)
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || strings.Contains(id, "..") || strings.Contains(id, "/") {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_job_id", "Invalid job ID")
		return
	}
	job, ok := s.jobs.Get(id)
	if !ok {
		writeErrorJSON(w, http.StatusNotFound, "job_not_found", fmt.Sprintf("Job %q not found", id))
		return
	}
	if r.URL.Query().Get("wait") == "1" {
		deadline := time.Now().Add(4 * time.Second)
		for (job.Status == jobs.StatusQueued || job.Status == jobs.StatusRunning) && time.Now().Before(deadline) {
			time.Sleep(15 * time.Millisecond)
			if next, exists := s.jobs.Get(id); exists {
				job = next
			} else {
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" || strings.Contains(id, "..") || strings.Contains(id, "/") {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_job_id", "Invalid job ID")
		return
	}
	job, ok := s.jobs.Cancel(id)
	if !ok {
		writeErrorJSON(w, http.StatusNotFound, "job_not_found", fmt.Sprintf("Job %q not found", id))
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleDownloadStem(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	stemName := strings.TrimSpace(strings.ToLower(r.PathValue("stemName")))
	stemName = strings.TrimSuffix(stemName, ".wav")
	if strings.Contains(id, "..") || strings.Contains(stemName, "..") || strings.Contains(stemName, "/") || strings.Contains(stemName, `\`) {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_stem_path", "Invalid job or stem identifier")
		return
	}

	wavBytes, ok := s.jobs.StemWAV(id, stemName)
	if !ok {
		writeErrorJSON(w, http.StatusNotFound, "stem_not_found", fmt.Sprintf("Stem %q for job %q not found", stemName, id))
		return
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.wav"`, stemName))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wavBytes)
}

func (s *Server) handleStaticOrSPA(w http.ResponseWriter, r *http.Request) {
	cleanPath := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	relPath := strings.TrimPrefix(cleanPath, "/")
	if relPath == "" {
		relPath = "index.html"
	}

	// 1. Serve /wasm/* from WasmFS or StaticFS with application/wasm content type
	if strings.HasPrefix(relPath, "wasm/") && s.cfg.WasmFS != nil {
		wasmFile := strings.TrimPrefix(relPath, "wasm/")
		if data, err := fs.ReadFile(s.cfg.WasmFS, wasmFile); err == nil {
			setStaticContentType(w, relPath)
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
	}

	// 2. Serve from StaticFS (embedded Next.js 16 export)
	if s.cfg.StaticFS != nil {
		candidates := resolveStaticCandidates(relPath)
		for _, cand := range candidates {
			info, err := fs.Stat(s.cfg.StaticFS, cand)
			if err == nil && !info.IsDir() {
				data, readErr := fs.ReadFile(s.cfg.StaticFS, cand)
				if readErr == nil {
					setStaticContentType(w, cand)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(data)
					return
				}
			}
		}
	}

	// Fallback if static export is not mounted on this path
	if strings.HasPrefix(cleanPath, "/jobs/") || strings.HasPrefix(cleanPath, "/api/") {
		writeErrorJSON(w, http.StatusNotFound, "not_found", "API route not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Aurialis Mastering Studio</title></head><body><div id="app">Aurialis-WASM</div></body></html>`)
}

func resolveStaticCandidates(relPath string) []string {
	candidates := []string{
		relPath,
		relPath + ".html",
		path.Join(relPath, "index.html"),
	}
	// Map dynamic Next.js 16 App Router routes (/master/track-1, /split/track-1, /albums/album-1, etc.)
	// to their static export placeholder shell.
	parts := strings.Split(strings.Trim(relPath, "/"), "/")
	if len(parts) == 2 {
		switch parts[0] {
		case "master", "split", "albums", "reference", "release-check":
			candidates = append(candidates,
				path.Join(parts[0], "placeholder", "index.html"),
				path.Join(parts[0], "placeholder.html"),
				path.Join(parts[0], "track-1", "index.html"),
				path.Join(parts[0], "track-1.html"),
				path.Join(parts[0], "album-1", "index.html"),
				path.Join(parts[0], "album-1.html"),
			)
		}
	}
	return candidates
}

func setStaticContentType(w http.ResponseWriter, filePath string) {
	ext := strings.ToLower(path.Ext(filePath))
	switch ext {
	case ".wasm":
		w.Header().Set("Content-Type", "application/wasm")
	case ".js", ".mjs":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	case ".json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	default:
		if ct := mime.TypeByExtension(ext); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
	}
}
