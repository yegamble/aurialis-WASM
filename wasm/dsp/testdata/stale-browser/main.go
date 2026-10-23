//go:build js && wasm

// This fixture deliberately lacks the offline job ABI. It is compiled for the
// browser acceptance test so a clean checkout can reproduce stale initialization.
package main

import "syscall/js"

func main() {
	js.Global().Set("aurialisDSPReady", true)
	select {}
}
