//go:build js && wasm

package main

import (
	"encoding/json"
	"math"
	"syscall/js"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

// The JS boundary is an offline/block bridge. It is not an allocation-free
// AudioWorklet runtime: JS calls/boxing and Go runtime scheduling still apply.
const maxBridgeFrames = 65536

var globalBridge = NewBridge(48000)
var bridgeBuffers [4][maxBridgeFrames]float32

func jsInit(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeNumber {
		return false
	}
	rate := args[0].Float()
	if !finiteJS(rate) || rate < 8000 || rate > 192000 {
		return false
	}
	globalBridge.Init(rate)
	return true
}
func jsReset(_ js.Value, _ []js.Value) any { globalBridge.Reset(); return true }
func jsSetParams(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return false
	}
	return globalBridge.SetParamsJSON(args[0].String()) == nil
}
func jsSetBand(_ js.Value, args []js.Value) any {
	if len(args) < 4 || len(args) > 5 {
		return false
	}
	for _, arg := range args[:4] {
		if arg.Type() != js.TypeNumber || !finiteJS(arg.Float()) {
			return false
		}
	}
	index := args[0].Float()
	if index < 0 || index >= dsp.NumEQBands || index != math.Trunc(index) {
		return false
	}
	current := globalBridge.Params()
	idx := int(index)
	band := current.Bands[idx]
	band.FreqHz = args[1].Float()
	band.GainDB = args[2].Float()
	band.Q = args[3].Float()
	if len(args) == 5 {
		if args[4].Type() != js.TypeBoolean {
			return false
		}
		band.Enabled = args[4].Bool()
	}
	current.Bands[idx] = band
	if dsp.ValidateParams(current) != nil {
		return false
	}
	globalBridge.SetBand(idx, band)
	return true
}

func finiteJS(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }
func float32Array(value js.Value) bool {
	return value.Type() == js.TypeObject && !value.IsNull() && value.InstanceOf(js.Global().Get("Float32Array"))
}
func frameCount(args []js.Value) int {
	if len(args) < 2 || !float32Array(args[0]) || !float32Array(args[1]) {
		return 0
	}
	n := args[0].Length()
	if n < 1 || n > maxBridgeFrames || args[1].Length() != n {
		return 0
	}
	return n
}
func readChannels(args []js.Value, n int) bool {
	for i := 0; i < n; i++ {
		left, right := args[0].Index(i).Float(), args[1].Index(i).Float()
		if !finiteJS(left) || !finiteJS(right) {
			return false
		}
		bridgeBuffers[0][i], bridgeBuffers[1][i] = float32(left), float32(right)
	}
	return true
}
func jsProcessBlock(_ js.Value, args []js.Value) any {
	if len(args) != 2 && len(args) != 4 {
		return 0
	}
	n := frameCount(args)
	if n == 0 {
		return 0
	}
	dstL, dstR := args[0], args[1]
	if len(args) == 4 {
		dstL, dstR = args[2], args[3]
		if !float32Array(dstL) || !float32Array(dstR) || dstL.Length() < n || dstR.Length() < n {
			return 0
		}
	}
	if !readChannels(args, n) {
		return 0
	}
	globalBridge.ProcessBlock(bridgeBuffers[0][:n], bridgeBuffers[1][:n], bridgeBuffers[2][:n], bridgeBuffers[3][:n])
	for i := 0; i < n; i++ {
		dstL.SetIndex(i, float64(bridgeBuffers[2][i]))
		dstR.SetIndex(i, float64(bridgeBuffers[3][i]))
	}
	return n
}
func jsMeasure(_ js.Value, args []js.Value) any {
	if len(args) != 2 {
		return "{}"
	}
	n := frameCount(args)
	if n == 0 || !readChannels(args, n) {
		return "{}"
	}
	metrics := globalBridge.Measure(bridgeBuffers[0][:n], bridgeBuffers[1][:n])
	raw, err := json.Marshal(metrics)
	if err != nil {
		return "{}"
	}
	return string(raw)
}
func main() {
	global := js.Global()
	global.Set("aurialisDSPInit", js.FuncOf(jsInit))
	global.Set("aurialisDSPReset", js.FuncOf(jsReset))
	global.Set("aurialisDSPSetParams", js.FuncOf(jsSetParams))
	global.Set("aurialisDSPSetBand", js.FuncOf(jsSetBand))
	global.Set("aurialisDSPProcessBlock", js.FuncOf(jsProcessBlock))
	global.Set("aurialisDSPMeasure", js.FuncOf(jsMeasure))
	global.Set("aurialisDSPReady", true)
	select {}
}
