package server

import (
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

// Hash the exact inline bootstrap bytes in the trusted static export. External
// scripts remain same-origin; arbitrary inline script execution is not allowed.
func buildCSP(assets fs.FS) string {
	scripts := regexp.MustCompile(`(?is)<script\b[^>]*>(.*?)</script\s*>`)
	hashes := make(map[string]bool)
	if assets != nil {
		_ = fs.WalkDir(assets, ".", func(name string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(name, ".html") {
				return err
			}
			data, readErr := fs.ReadFile(assets, name)
			if readErr != nil {
				return readErr
			}
			for _, match := range scripts.FindAllSubmatch(data, -1) {
				if len(match[1]) == 0 {
					continue
				}
				hash := sha256.Sum256(match[1])
				hashes["'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'"] = true
			}
			return nil
		})
	}
	ordered := make([]string, 0, len(hashes))
	for hash := range hashes {
		ordered = append(ordered, hash)
	}
	sort.Strings(ordered)
	return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' " + strings.Join(ordered, " ") + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
}
