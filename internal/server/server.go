// Package server implements the hardened HTTP/JSON API, Audio CDR upload handler,
// COOP/COEP WebAssembly isolation middleware, and embedded Next.js 16 static server.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/audio"
	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
	"github.com/yegamble/Aurialis-WASM/internal/jobs"
	"github.com/yegamble/Aurialis-WASM/internal/mastering"
)

// DefaultMaxUploadBytes allows a maximum canonical stereo-float WAV plus bounded multipart fields.
const DefaultMaxUploadBytes int64 = 129 * 1024 * 1024

// MaxAudioFileBytes bounds one file at the decoded-frame ceiling, including its WAV header.
const MaxAudioFileBytes int64 = int64(audio.MaxDecodedFrames)*8 + 44

// Config configures the Aurialis HTTP server.
type Config struct {
	MaxUploadBytes int64
	Workers        int
	StaticFS       fs.FS
	WasmFS         fs.FS
	ListenAddress  string
}

// Server serves the Aurialis HTTP API and embedded Next.js + WASM assets.
type Server struct {
	cfg     Config
	jobs    *jobs.Manager
	handler http.Handler
	uploads chan struct{}
	csp     string
}

// New constructs a new Aurialis HTTP server and starts the worker pool.
func New(cfg Config) *Server {
	if cfg.MaxUploadBytes <= 0 || cfg.MaxUploadBytes > DefaultMaxUploadBytes {
		cfg.MaxUploadBytes = DefaultMaxUploadBytes
	}

	s := &Server{
		cfg:     cfg,
		jobs:    jobs.NewManager(cfg.Workers),
		uploads: make(chan struct{}, 1),
		csp:     buildCSP(cfg.StaticFS),
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
		h.Set("Content-Security-Policy", s.csp)
		h.Set("Cache-Control", "no-store")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

		// 1. Validate Host header against DNS rebinding attacks
		if !isAllowedLocalHost(r.Host) || !s.listenerMatches(r) {
			writeErrorJSON(w, http.StatusForbidden, "forbidden_host", "Requests with non-local Host headers are rejected")
			return
		}

		// 2. Validate exact origins and fetch metadata against localhost CSRF.
		{
			if secSite := r.Header.Get("Sec-Fetch-Site"); secSite != "" && secSite != "same-origin" && secSite != "none" {
				writeErrorJSON(w, http.StatusForbidden, "csrf_rejected", "Cross-site state-changing requests are forbidden")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Scheme != "http" || u.Host != r.Host || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
					writeErrorJSON(w, http.StatusForbidden, "forbidden_origin", "Cross-origin state-changing requests are forbidden")
					return
				}
			}
		}
		if r.Method == http.MethodPost {
			if r.Context().Err() != nil {
				return
			}
			select {
			case s.uploads <- struct{}{}:
				defer func() { <-s.uploads }()
			case <-r.Context().Done():
				return
			default:
				w.Header().Set("Retry-After", "1")
				writeErrorJSON(w, http.StatusServiceUnavailable, "busy", "One audio request is already running; retry after it completes")
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
		}

		next.ServeHTTP(w, r)
	})
}

func isAllowedLocalHost(hostport string) bool {
	trimmed := strings.TrimSpace(hostport)
	if trimmed == "" || trimmed != hostport {
		return false
	}
	host := trimmed
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	switch host {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func (s *Server) listenerMatches(r *http.Request) bool {
	address := s.cfg.ListenAddress
	if local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		address = local.String()
	}
	if address == "" {
		return true
	} // In-process handlers have no listener.
	_, boundPort, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	_, requestPort, err := net.SplitHostPort(r.Host)
	return err == nil && requestPort == boundPort
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
	ready := false
	if s.cfg.WasmFS != nil {
		if info, err := fs.Stat(s.cfg.WasmFS, "aurialis-dsp.wasm"); err == nil && info.Size() > 8 {
			ready = true
		}
	}
	if !ready && s.cfg.StaticFS != nil {
		if info, err := fs.Stat(s.cfg.StaticFS, "wasm/aurialis-dsp.wasm"); err == nil && info.Size() > 8 {
			ready = true
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":                     "ok",
		"service":                    "aurialis-wasm",
		"version":                    "0.1.0",
		"wasmDsp":                    true,
		"wasmDspReady":               ready,
		"gpu":                        false,
		"models":                     []string{"deterministic-frequency-split"},
		"separationMethod":           "deterministic-frequency-split",
		"analysisMethod":             "deterministic-energy-heuristics",
		"maxUploadBytes":             s.cfg.MaxUploadBytes,
		"maxDecodedFrames":           audio.MaxDecodedFrames,
		"maxAudioFileBytes":          min(MaxAudioFileBytes, s.cfg.MaxUploadBytes),
		"maxConcurrentAudioRequests": 1,
		"jobMemoryBudgetBytes":       jobs.MaxMemoryBytes,
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
	reader, err := r.MultipartReader()
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Expected multipart/form-data upload")
		return nil, false
	}
	values := make(url.Values)
	var rawBytes []byte
	var filename string
	for count := 0; ; count++ {
		part, partErr := reader.NextRawPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			return uploadReadError(w, partErr)
		}
		if count >= 8 {
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Too many multipart fields")
			return nil, false
		}
		_, disposition, parseErr := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if parseErr != nil {
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Invalid multipart disposition")
			return nil, false
		}
		name := disposition["name"]
		switch {
		case name == "file" && rawBytes == nil && disposition["filename"] != "":
			filename = disposition["filename"] // Validate the original value before FileName can strip paths.
			if _, parseErr = audio.SanitizeFilename(filename); parseErr != nil {
				_ = part.Close()
				writeErrorJSON(w, http.StatusBadRequest, "invalid_audio", "Invalid audio filename")
				return nil, false
			}
			rawBytes, err = io.ReadAll(io.LimitReader(part, MaxAudioFileBytes+1))
			if int64(len(rawBytes)) > MaxAudioFileBytes {
				_ = part.Close()
				writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Audio file exceeds the decoded-frame storage limit")
				return nil, false
			}
		case (name == "stems" || name == "model" || name == "profile" || name == "params" || name == "bitDepth" || name == "format") && disposition["filename"] == "" && values[name] == nil:
			var value []byte
			value, err = io.ReadAll(io.LimitReader(part, 64*1024+1))
			if len(value) > 64*1024 {
				_ = part.Close()
				writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Multipart field exceeds 64 KiB")
				return nil, false
			}
			values[name] = []string{string(value)}
		default:
			_ = part.Close()
			writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Unknown or duplicate multipart field")
			return nil, false
		}
		_ = part.Close()
		if err != nil {
			return uploadReadError(w, err)
		}
		if r.Context().Err() != nil {
			writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Audio request canceled")
			return nil, false
		}
	}
	if rawBytes == nil {
		writeErrorJSON(w, http.StatusBadRequest, "missing_file", "Form field 'file' is required")
		return nil, false
	}
	// Populate values only; multipart parsing never creates raw upload files on disk.
	r.MultipartForm = &multipart.Form{Value: values}
	r.Form = values
	buf, err := audio.DecodeAndDisarm(filename, rawBytes)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_audio", err.Error())
		return nil, false
	}
	return buf, true
}

func uploadReadError(w http.ResponseWriter, err error) (*audio.Buffer, bool) {
	var limitErr *http.MaxBytesError
	if errors.As(err, &limitErr) {
		writeErrorJSON(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Uploaded request exceeds size limit")
	} else {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_multipart", "Malformed or incomplete multipart upload")
	}
	return nil, false
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
		case "deterministic-frequency-split", "htdemucs", "htdemucs_ft", "default", "standard":
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
		parsed, err := dsp.DecodeParamsJSON([]byte(rawParams), params)
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_params", "Invalid DSP params JSON")
			return
		}
		params = parsed
	}

	if err := dsp.ValidateParams(params); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid_params", err.Error())
		return
	}

	bitDepth := 24
	if rawBits := strings.TrimSpace(r.FormValue("bitDepth")); rawBits != "" {
		parsed, err := strconv.Atoi(rawBits)
		if err != nil || (parsed != 16 && parsed != 24 && parsed != 32) {
			writeErrorJSON(w, http.StatusBadRequest, "invalid_bit_depth", "bitDepth must be 16, 24 or 32")
			return
		}
		bitDepth = parsed
	}
	if bitDepth == 16 || bitDepth == 24 {
		params.DitherBits = bitDepth
	}

	beforeMetrics, measureErr := dsp.MeasureStereoContext(r.Context(), buf.Left, buf.Right, float64(buf.SampleRate))
	if measureErr != nil {
		writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Audio measurement canceled or timed out")
		return
	}
	outL, outR, afterMetrics, renderErr := dsp.RenderBufferContext(r.Context(), buf.Left, buf.Right, float64(buf.SampleRate), params)
	if renderErr != nil {
		writeErrorJSON(w, http.StatusRequestTimeout, "canceled", "Audio rendering canceled or timed out")
		return
	}

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
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Content-Disposition", `attachment; filename="aurialis-mastered.wav"`)
	w.Header().Set("X-Aurialis-Before-LUFS", fmt.Sprintf("%.2f", beforeMetrics.IntegratedLUFS))
	w.Header().Set("X-Aurialis-After-LUFS", fmt.Sprintf("%.2f", afterMetrics.IntegratedLUFS))
	w.Header().Set("X-Aurialis-After-Peak-dBTP", fmt.Sprintf("%.2f", afterMetrics.TruePeakDBTP))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wavBytes) // #nosec G705 -- canonical PCM WAV synthesized by EncodeWAV; fixed audio/wav and nosniff headers
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
			select {
			case <-r.Context().Done():
				return
			case <-time.After(15 * time.Millisecond):
			}
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
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.wav"`, stemName))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(wavBytes) // #nosec G705 -- canonical PCM stem WAV; fixed audio/wav and nosniff headers
}

func (s *Server) handleStaticOrSPA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeErrorJSON(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
		return
	}
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
			_, _ = w.Write(data) // #nosec G705 -- trusted static application assets, never uploaded bytes
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
					_, _ = w.Write(data) // #nosec G705 -- trusted static application assets, never uploaded bytes
					return
				}
			}
		}
	}

	// Fallback if static export is not mounted on this path
	if strings.HasPrefix(cleanPath, "/jobs/") || strings.HasPrefix(cleanPath, "/api/") || path.Ext(cleanPath) != "" {
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
