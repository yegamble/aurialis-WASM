//go:build js && wasm

package main

import (
	"context"
	"syscall/js"

	"github.com/yegamble/Aurialis-WASM/internal/browserjobs"
)

func offlineInput(value js.Value) ([]byte, bool) {
	if value.Type() != js.TypeObject || value.IsNull() {
		return nil, false
	}
	// Genuine typed-array getters reject shadowed lengths, detached views and
	// SharedArrayBuffer input. All binary data is private to this job worker.
	tag := channelIntrinsics.tag.Call("call", value)
	if tag.Type() != js.TypeString || tag.String() != "Uint8Array" {
		return nil, false
	}
	buffer := channelIntrinsics.buffer.Call("call", value)
	if channelIntrinsics.sharedType.Type() == js.TypeFunction && channelIntrinsics.hasInstance.Call("call", channelIntrinsics.sharedType, buffer).Bool() {
		return nil, false
	}
	length := channelIntrinsics.length.Call("call", value).Int()
	if length < 0 || length > browserjobs.MaxInputBytes {
		return nil, false
	}
	raw := make([]byte, length)
	if js.CopyBytesToGo(raw, value) != length {
		return nil, false
	}
	return raw, true
}

func offlineError(message string) any {
	return map[string]any{"ok": false, "error": message}
}

// One synchronous call belongs to a disposable dedicated Worker. Main-thread
// cancellation terminates that Worker, releasing its entire private Go heap.
func jsOfflineJob(_ js.Value, args []js.Value) any {
	if len(args) != 4 || args[0].Type() != js.TypeString || args[3].Type() != js.TypeFunction {
		return offlineError("Invalid local audio request")
	}
	raw := []byte(args[0].String())
	if _, err := browserjobs.DecodeRequest(raw); err != nil {
		return offlineError(err.Error())
	}
	source, ok := offlineInput(args[1])
	if !ok {
		return offlineError("Invalid local source buffer")
	}
	reference, ok := offlineInput(args[2])
	if !ok || len(reference) > browserjobs.MaxInputBytes-len(source) {
		return offlineError("Invalid or oversized local reference buffer")
	}
	result, err := browserjobs.Execute(context.Background(), raw, source, reference, func(progress int, stage string) {
		args[3].Invoke(progress, stage)
	})
	if err != nil {
		return offlineError(err.Error())
	}
	output := channelIntrinsics.uint8Type.New(len(result.Audio))
	js.CopyBytesToJS(output, result.Audio)
	return map[string]any{"ok": true, "json": string(result.Metadata), "audio": output}
}
