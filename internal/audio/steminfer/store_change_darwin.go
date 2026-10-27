package steminfer

// cspell:words Ctimespec

import (
	"io/fs"
	"strconv"
	"syscall"
)

// changeStamp is the file's inode and change time. The kernel sets the change
// time on every write, chmod or utimes call and offers no call to set it back,
// so a same-size edit with its modification time restored still changes it.
func changeStamp(info fs.FileInfo) string {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return strconv.FormatUint(stat.Ino, 10) + ":" + strconv.FormatInt(stat.Ctimespec.Nano(), 10)
}
