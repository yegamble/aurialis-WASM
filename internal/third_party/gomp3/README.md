# gomp3

A trimmed copy of [github.com/hajimehoshi/go-mp3](https://github.com/hajimehoshi/go-mp3) v0.3.4
(Apache-2.0, see `LICENSE` and `AUTHORS`), vendored so Aurialis can decode MP3
to float32 without an external module. It is excluded from golangci-lint and
cspell as third-party code; behavior is covered by `internal/audio` fixture,
FFmpeg-oracle and fuzz tests.

Local modifications:

- `decode.go` replaces the upstream `Decoder`/`source` with a bounded
  whole-buffer `Decode` that returns stereo float32 and rejects sample-rate
  changes.
- Synthesis keeps float samples instead of quantizing and clipping to 16-bit.
- M/S stereo now transforms all 576 lines. Upstream bounded it by `Count1`,
  which is measured before short-block reordering, so lines moved past it were
  left undecoded (audible error on short-block joint-stereo frames).
- Performance: 32-point DCT-II matrixing, ring-buffered synthesis window,
  fused windowing, 18-output IMDCT using its symmetry, zero-subband skipping,
  quarter-step `2^x` table, and in-place frame reuse.
- Struct literal keys for `UnexpectedEOF` (go vet).
