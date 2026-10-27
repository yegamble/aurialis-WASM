package main

// cspell:words steminfer

import (
	"testing"

	"github.com/yegamble/Aurialis-WASM/internal/audio/steminfer"
	"github.com/yegamble/Aurialis-WASM/internal/server"
)

func TestConfigureStemsReportsBackendAndCacheState(t *testing.T) {
	var disabled server.Config
	if err := configureStems(&disabled, "", t.TempDir()); err != nil || disabled.Separator != nil || disabled.StemModelStatus != nil {
		t.Fatalf("empty URL still configured Smart Split: %v", err)
	}

	var cfg server.Config
	if err := configureStems(&cfg, "http://127.0.0.1:9/model", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	// Plain Go did not finish one window in 30 minutes, so only an
	// accelerated build runs separations.
	if (cfg.Separator != nil) != steminfer.Accelerated() {
		t.Fatalf("separator wired %v on accelerated %v", cfg.Separator != nil, steminfer.Accelerated())
	}
	status := cfg.StemModelStatus()
	if status.State != string(steminfer.ModelAbsent) || status.Ready || status.Downloading || status.Total != steminfer.ModelBytes {
		t.Fatalf("empty cache status %+v", status)
	}
	if status.Backend != steminfer.Backend() || status.Accelerated != steminfer.Accelerated() {
		t.Fatalf("backend %s accelerated %v", status.Backend, status.Accelerated)
	}
	if (status.Speed != nil) != steminfer.Accelerated() {
		t.Fatalf("speed %+v on accelerated %v", status.Speed, steminfer.Accelerated())
	}
	if status.Speed != nil && (status.Speed.IdleSecondsPerWindow != 32 || status.Speed.WindowSeconds != 20 || status.Speed.HopSeconds != 10) {
		t.Fatalf("speed %+v", status.Speed)
	}
}
