// Copyright 2017 Hajime Hoshi
// Modifications copyright 2026 Aurialis contributors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package gomp3 is a trimmed copy of github.com/hajimehoshi/go-mp3 v0.3.4
// (MPEG-1/2 Layer III) that decodes to float32 instead of clipped 16-bit PCM.
// See README.md in this directory for the list of local modifications.
package gomp3

import (
	"errors"
	"io"

	"github.com/yegamble/Aurialis-WASM/internal/third_party/gomp3/internal/consts"
	"github.com/yegamble/Aurialis-WASM/internal/third_party/gomp3/internal/frame"
)

// ErrTooLong is returned when decoding would exceed the caller's frame limit.
var ErrTooLong = errors.New("mp3: decoded audio exceeds frame limit")

// ErrSampleRateChange is returned when frames disagree on sample rate.
var ErrSampleRateChange = errors.New("mp3: sample rate changes mid-stream")

type byteSource struct {
	data []byte
	pos  int
}

func (s *byteSource) ReadFull(buf []byte) (int, error) {
	n := copy(buf, s.data[s.pos:])
	s.pos += n
	if n < len(buf) {
		return n, io.EOF
	}
	return n, nil
}

// Result is decoded stereo PCM. Mono streams are duplicated to both channels.
type Result struct {
	SampleRate int
	Channels   int
	Left       []float32
	Right      []float32
}

// Decode decodes every Layer III frame in data, which must start at the first
// frame (tags already removed). maxFrames bounds the decoded sample frames and
// capacity preallocates the output.
func Decode(data []byte, maxFrames, capacity int) (*Result, error) {
	src := &byteSource{data: data}
	var prev *frame.Frame
	capacity = min(max(capacity, 0), maxFrames)
	res := Result{Left: make([]float32, 0, capacity), Right: make([]float32, 0, capacity)}
	for {
		f, _, err := frame.Read(src, int64(src.pos), prev)
		if err != nil {
			var unexpected *consts.UnexpectedEOF
			if errors.Is(err, io.EOF) || errors.As(err, &unexpected) {
				break
			}
			return nil, err
		}
		rate, err := f.SamplingFrequency()
		if err != nil {
			return nil, err
		}
		if res.SampleRate == 0 {
			res.SampleRate = rate
		} else if rate != res.SampleRate {
			return nil, ErrSampleRateChange
		}
		if ch := f.NumberOfChannels(); ch > res.Channels {
			res.Channels = ch
		}
		pcm := f.Decode()
		if len(res.Left)+len(pcm)/2 > maxFrames {
			return nil, ErrTooLong
		}
		for i := 0; i+1 < len(pcm); i += 2 {
			res.Left = append(res.Left, pcm[i])
			res.Right = append(res.Right, pcm[i+1])
		}
		prev = f
	}
	if res.SampleRate == 0 {
		return nil, io.ErrUnexpectedEOF
	}
	return &res, nil
}
