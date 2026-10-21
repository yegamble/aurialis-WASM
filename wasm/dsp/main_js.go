//go:build js && wasm

package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/yegamble/Aurialis-WASM/internal/audio/dsp"
)

var globalBridge = NewBridge(48000.0)

func jsInit(_ js.Value, args []js.Value) any {
	sr := 48000.0
	if len(args) > 0 && args[0].Type() == js.TypeNumber {
		sr = args[0].Float()
	}
	globalBridge.Init(sr)
	return true
}

func jsReset(_ js.Value, _ []js.Value) any {
	globalBridge.Reset()
	return true
}

func jsSetParams(_ js.Value, args []js.Value) any {
	if len(args) == 0 || args[0].Type() != js.TypeString {
		return false
	}
	err := globalBridge.SetParamsJSON(args[0].String())
	return err == nil
}

func jsSetBand(_ js.Value, args []js.Value) any {
	if len(args) < 4 {
		return false
	}
	idx := args[0].Int()
	current := globalBridge.Params()
	if idx < 0 || idx >= dsp.NumEQBands {
		return false
	}
	b := current.Bands[idx]
	b.FreqHz = args[1].Float()
	b.GainDB = args[2].Float()
	b.Q = args[3].Float()
	if len(args) >= 5 && args[4].Type() == js.TypeBoolean {
		b.Enabled = args[4].Bool()
	}
	globalBridge.SetBand(idx, b)
	return true
}

func jsProcessBlock(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return 0
	}
	arrL := args[0]
	arrR := args[1]
	n := arrL.Length()
	if arrR.Length() < n {
		n = arrR.Length()
	}
	if n <= 0 {
		return 0
	}

	inL := make([]float32, n)
	inR := make([]float32, n)
	outL := make([]float32, n)
	outR := make([]float32, n)
	for i := 0; i < n; i++ {
		inL[i] = float32(arrL.Index(i).Float())
		inR[i] = float32(arrR.Index(i).Float())
	}

	globalBridge.ProcessBlock(inL, inR, outL, outR)

	dstL := arrL
	dstR := arrR
	if len(args) >= 4 {
		dstL = args[2]
		dstR = args[3]
	}
	for i := 0; i < n; i++ {
		dstL.SetIndex(i, float64(outL[i]))
		dstR.SetIndex(i, float64(outR[i]))
	}
	return n
}

func jsMeasure(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return "{}"
	}
	arrL := args[0]
	arrR := args[1]
	n := arrL.Length()
	if arrR.Length() < n {
		n = arrR.Length()
	}
	left := make([]float32, n)
	right := make([]float32, n)
	for i := 0; i < n; i++ {
		left[i] = float32(arrL.Index(i).Float())
		right[i] = float32(arrR.Index(i).Float())
	}
	m := globalBridge.Measure(left, right)
	raw, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func main() {
	g := js.Global()
	g.Set("aurialisDSPInit", js.FuncOf(jsInit))
	g.Set("aurialisDSPReset", js.FuncOf(jsReset))
	g.Set("aurialisDSPSetParams", js.FuncOf(jsSetParams))
	g.Set("aurialisDSPSetBand", js.FuncOf(jsSetBand))
	g.Set("aurialisDSPProcessBlock", js.FuncOf(jsProcessBlock))
	g.Set("aurialisDSPMeasure", js.FuncOf(jsMeasure))
	select {}
}
