// Package webui embeds the compiled Next.js 16 static frontend and WebAssembly
// DSP binaries into the single Aurialis Go executable.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embeddedDist embed.FS

// DistFS returns the embedded filesystem rooted at dist/.
func DistFS() (fs.FS, error) {
	return fs.Sub(embeddedDist, "dist")
}
