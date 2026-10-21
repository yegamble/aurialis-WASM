// Package webui embeds the compiled Next.js 16 static frontend and WebAssembly
// DSP binaries into the single Aurialis Go executable.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:embedded
var embeddedAssets embed.FS

// DistFS returns the embedded filesystem rooted at embedded/.
func DistFS() (fs.FS, error) {
	return fs.Sub(embeddedAssets, "embedded")
}
