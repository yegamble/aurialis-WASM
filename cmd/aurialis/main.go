// Package main is the single-binary entrypoint for the Aurialis-WASM audio mastering workstation.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yegamble/Aurialis-WASM/internal/server"
	"github.com/yegamble/Aurialis-WASM/internal/webui"
)

func resolveListenAddr(flagAddr string) string {
	if envAddr := strings.TrimSpace(os.Getenv("AURIALIS_ADDR")); envAddr != "" {
		return envAddr
	}
	if envPort := strings.TrimSpace(os.Getenv("PORT")); envPort != "" {
		if strings.Contains(envPort, ":") {
			return envPort
		}
		return "127.0.0.1:" + envPort
	}
	return flagAddr
}

func resolveMaxUploadBytes(flagVal int64) int64 {
	if envVal := strings.TrimSpace(os.Getenv("MAX_UPLOAD_BYTES_OVERRIDE")); envVal != "" {
		if parsed, err := strconv.ParseInt(envVal, 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return flagVal
}

func resolveStaticFS() fs.FS {
	embedded, err := webui.DistFS()
	if err != nil {
		return nil
	}
	return embedded
}

func resolveWasmFS() fs.FS {
	embedded, err := webui.DistFS()
	if err != nil {
		return nil
	}
	sub, err := fs.Sub(embedded, "wasm")
	if err != nil {
		return nil
	}
	return sub
}

func run() error {
	addrFlag := flag.String("addr", "127.0.0.1:8080", "HTTP listen address (loopback IP only)")
	workersFlag := flag.Int("workers", 0, "Number of concurrent audio DSP workers (0 = auto)")
	maxUploadFlag := flag.Int64("max-upload-bytes", server.DefaultMaxUploadBytes, "Maximum upload size in bytes")
	flag.Parse()

	listenAddr := resolveListenAddr(*addrFlag)
	maxUpload := resolveMaxUploadBytes(*maxUploadFlag)
	if maxUpload <= 0 || maxUpload > server.DefaultMaxUploadBytes {
		return fmt.Errorf("maximum upload must be between 1 and %d bytes", server.DefaultMaxUploadBytes)
	}
	listenHost, _, err := net.SplitHostPort(listenAddr)
	if err != nil || net.ParseIP(listenHost) == nil || !net.ParseIP(listenHost).IsLoopback() {
		return errors.New("listen address must use a loopback IP")
	}
	listenConfig := net.ListenConfig{}
	listener, err := listenConfig.Listen(context.Background(), "tcp", listenAddr)
	if err != nil {
		return fmt.Errorf("open loopback listener: %w", err)
	}
	defer func() { _ = listener.Close() }()
	listenAddr = listener.Addr().String()

	srv := server.New(server.Config{
		MaxUploadBytes: maxUpload,
		Workers:        *workersFlag,
		StaticFS:       resolveStaticFS(),
		WasmFS:         resolveWasmFS(),
		ListenAddress:  listenAddr,
	})
	defer srv.Close()

	httpServer := &http.Server{
		Addr:              listenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	fmt.Printf("Aurialis-WASM listening on http://%s (maxUpload=%d bytes)\n", listenAddr, maxUpload)
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("Aurialis-WASM server failed: %w", err)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
