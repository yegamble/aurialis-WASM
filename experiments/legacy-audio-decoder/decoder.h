/* Private decoder experiment; redistribution and LGPL compliance review pending. */
#ifndef AURIALIS_LEGACY_DECODER_H
#define AURIALIS_LEGACY_DECODER_H
#include <stdint.h>
#define AURIALIS_DECODER_ABI 1
#define AURIALIS_CHUNK_FRAMES 4096
enum AurialisInput { AUR_MP3 = 1, AUR_FLAC, AUR_OGG, AUR_ADTS, AUR_MP4 };
enum AurialisError { AUR_INVALID = -1, AUR_UNSUPPORTED = -2, AUR_LIMIT = -3, AUR_DECODE = -4, AUR_STATE = -5 };
/* Exactly one decoder per disposable instance. There is no path/URL API.
 * Format is supplied by the bounded envelope preflight, not a filename.
 * next() returns 1..4096 actual frames, 0 only on decoder EOF with consistent frame counters, or an error.
 * Output is interleaved stereo Float32; mono duplicates its sole channel.
 * rate/channels/frames reflect decoded frames, never container duration.
 */
int aurialis_decoder_abi(void);
int aurialis_decoder_open(uint32_t format, uint32_t input_bytes, uint32_t max_frames);
int aurialis_decoder_next(void);
const float *aurialis_decoder_output(void);
uint32_t aurialis_decoder_rate(void);
uint32_t aurialis_decoder_channels(void);
uint32_t aurialis_decoder_frames(void);
void aurialis_decoder_close(void);
#endif
