//go:build js && wasm

package main

import (
	"syscall/js"

	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
)

func main() {
	global := js.Global()
	global.Set("aurialisOfflineAbi", browserjobs.ABIVersion)
	global.Set("aurialisOfflineJob", js.FuncOf(jsOfflineJob))
	global.Set("aurialisOfflineReady", true)
	registerLegacyBridge()
	select {}
}
