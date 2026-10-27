//go:build !darwin && !linux

package steminfer

import "io/fs"

// changeStamp is empty where the platform reports no change time; the
// marker then rests on size and modification time alone.
func changeStamp(fs.FileInfo) string { return "" }
