//go:build js && wasm

package main

// cspell:words nolint

import (
	"encoding/binary"
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

// Fixed byte scratch keeps the JS transfer bounded without unsafe float aliases.
// Input bytes are no longer needed when these buffers encode the output.
var bridgeBytes [2][maxBridgeFrames * 4]byte

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

// Cache the genuine typed-array accessors. Own properties such as length,
// buffer and byteOffset do not describe a typed array's backing storage.
var channelIntrinsics = loadChannelIntrinsics()

type typedArrayIntrinsics struct {
	float32Type, uint8Type, sharedType       js.Value
	length, offset, buffer, tag, hasInstance js.Value
}

func loadChannelIntrinsics() typedArrayIntrinsics {
	global := js.Global()
	object := global.Get("Object")
	float32Type := global.Get("Float32Array")
	prototype := object.Call("getPrototypeOf", float32Type.Get("prototype"))
	getter := func(key any) js.Value {
		return object.Call("getOwnPropertyDescriptor", prototype, key).Get("get")
	}
	return typedArrayIntrinsics{
		float32Type: float32Type, uint8Type: global.Get("Uint8Array"), sharedType: global.Get("SharedArrayBuffer"),
		length: getter("length"), offset: getter("byteOffset"), buffer: getter("buffer"),
		tag:         getter(global.Get("Symbol").Get("toStringTag")),
		hasInstance: object.Call("getOwnPropertyDescriptor", global.Get("Function").Get("prototype"), global.Get("Symbol").Get("hasInstance")).Get("value"),
	}
}

type channelByteView struct {
	value, samples, buffer js.Value
	offset, length         float64
	shared                 bool
}

func inspectChannel(value js.Value) (channelByteView, bool) {
	if value.Type() != js.TypeObject || value.IsNull() {
		return channelByteView{}, false
	}
	tag := channelIntrinsics.tag.Call("call", value)
	if tag.Type() != js.TypeString || tag.String() != "Float32Array" || !channelIntrinsics.hasInstance.Call("call", channelIntrinsics.float32Type, value).Bool() {
		return channelByteView{}, false
	}
	buffer := channelIntrinsics.buffer.Call("call", value)
	return channelByteView{
		samples: value, buffer: buffer,
		offset: channelIntrinsics.offset.Call("call", value).Float(),
		length: channelIntrinsics.length.Call("call", value).Float(),
		shared: channelIntrinsics.sharedType.Type() == js.TypeFunction && channelIntrinsics.hasInstance.Call("call", channelIntrinsics.sharedType, buffer).Bool(),
	}, true
}

// All property inspection and byte-view construction finishes before DSP state
// can advance. A JS exception from invalid/detached views rejects only this call.
// Never recover processing errors after the engine has consumed a block.
func prepareChannels(args []js.Value) (channels [4]channelByteView, n int) {
	defer func() {
		if recover() != nil {
			channels, n = [4]channelByteView{}, 0
		}
	}()
	if len(args) != 2 && len(args) != 4 {
		return channels, 0
	}
	for index, value := range args {
		channel, valid := inspectChannel(value)
		if !valid {
			return channels, 0
		}
		channels[index] = channel
	}
	length := channels[0].length
	//nolint:gosec // G602: channels is a fixed [4] array; constant index 1 is always in bounds.
	if length < 1 || length > maxBridgeFrames || channels[1].length != length {
		return channels, 0
	}
	n = int(length)
	if len(args) == 2 {
		channels[2], channels[3] = channels[0], channels[1]
	}
	for index, channel := range channels {
		if channel.length < length {
			return channels, 0
		}
		channels[index].value = channelIntrinsics.uint8Type.New(channel.buffer, channel.offset, n*4)
	}
	return channels, n
}

func readChannels(channels [4]channelByteView, n int) bool {
	for channel := 0; channel < 2; channel++ {
		view := channels[channel]
		raw := bridgeBytes[channel][:n*4]
		if js.CopyBytesToGo(raw, view.value) != len(raw) {
			return false
		}
		for i := 0; i < n; i++ {
			bits := binary.LittleEndian.Uint32(raw[i*4:])
			if bits == 0x80000000 {
				bits = 0 // syscall/js numeric transfers canonicalize negative zero.
			}
			sample := math.Float32frombits(bits)
			if !finiteJS(float64(sample)) {
				return false
			}
			bridgeBuffers[channel][i] = sample
		}
	}
	return true
}

func writeChannels(channels [4]channelByteView, n int) {
	left, right := channels[2], channels[3]
	shared := left.shared && right.shared
	if shared || (left.buffer.Equal(right.buffer) && left.offset < right.offset+float64(n*4) && right.offset < left.offset+float64(n*4)) {
		// Shifted overlapping destinations depend on the original interleaved
		// L[i], R[i] ordering. Shared buffers can alias through distinct cloned
		// wrappers, so conservatively preserve the ordering for those too.
		for i := 0; i < n; i++ {
			left.samples.SetIndex(i, float64(bridgeBuffers[2][i]))
			right.samples.SetIndex(i, float64(bridgeBuffers[3][i]))
		}
		return
	}
	for channel := 0; channel < 2; channel++ {
		raw := bridgeBytes[channel][:n*4]
		for i := 0; i < n; i++ {
			sample := bridgeBuffers[channel+2][i]
			bits := math.Float32bits(sample)
			if sample == 0 {
				bits = 0 // Match the original SetIndex numeric transfer.
			}
			binary.LittleEndian.PutUint32(raw[i*4:], bits)
		}
	}
	js.CopyBytesToJS(left.value, bridgeBytes[0][:n*4])
	js.CopyBytesToJS(right.value, bridgeBytes[1][:n*4])
}

func jsProcessBlock(_ js.Value, args []js.Value) any {
	if len(args) != 2 && len(args) != 4 {
		return 0
	}
	channels, n := prepareChannels(args)
	if n == 0 || !readChannels(channels, n) {
		return 0
	}
	globalBridge.ProcessBlock(bridgeBuffers[0][:n], bridgeBuffers[1][:n], bridgeBuffers[2][:n], bridgeBuffers[3][:n])
	writeChannels(channels, n)
	return n
}
func jsMeasure(_ js.Value, args []js.Value) any {
	if len(args) != 2 {
		return "{}"
	}
	channels, n := prepareChannels(args)
	if n == 0 || !readChannels(channels, n) {
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
