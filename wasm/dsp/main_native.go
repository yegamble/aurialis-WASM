//go:build !(js && wasm)

package main

func main() {
	// Native build entrypoint used by go vet / staticcheck / go test on host platforms.
	_ = NewBridge(48000.0)
}
