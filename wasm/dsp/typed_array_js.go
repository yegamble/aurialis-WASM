//go:build js && wasm

package main

import "syscall/js"

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
