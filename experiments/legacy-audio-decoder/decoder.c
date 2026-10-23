/* Private source-only foundation. No compiled, parser or audio qualification.
 * FFmpeg-derived behavior is governed by its corresponding LGPL sources.
 * Our wrapper's redistribution terms remain pending review.
 */
#include "decoder.h"
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/macros.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>

/* The sole application input import reads a selected browser File range.
 * FILESYSTEM=0 still emits abort/no-op Emscripten syscall stubs; there is no
 * usable filesystem, protocol, network, exec or arbitrary-callback API. */
extern int aurialis_read(uint32_t offset, uint8_t *destination, uint32_t bytes);
#define MAX_INPUT (200U * 1024U * 1024U)
#define MAX_FRAMES 16777216U
#define MAX_READ 65536U
#define MAX_CALLS 1048576U
#define MAX_SEEKS 65536U
#define MAX_PACKETS 1048576U
#define MAX_METADATA (1024U * 1024U)
#define MAX_SINGLE_ALLOC (8U * 1024U * 1024U)

typedef struct Decoder {
    AVFormatContext *format;
    AVCodecContext *codec;
    AVIOContext *io;
    AVPacket *packet;
    AVFrame *frame;
    uint32_t bytes, position, max_frames, frames, rate, channels;
    uint32_t reads, seeks, packets, frame_offset;
    uint64_t read_bytes;
    int opened, draining, eof, failed, pending_packet;
    float output[AURIALIS_CHUNK_FRAMES * 2];
} Decoder;
static Decoder state;

static int fail(int error) {
    if (!state.failed) state.failed = error;
    return state.failed;
}
static int io_failure(int domain, int ffmpeg_error) {
    fail(domain);
    return ffmpeg_error;
}
static int read_packet(void *opaque, uint8_t *buffer, int count) {
    Decoder *decoder = opaque;
    if (decoder->failed) return AVERROR(EIO);
    if (count <= 0 || decoder->position > decoder->bytes) return io_failure(AUR_DECODE, AVERROR(EINVAL));
    if (decoder->position == decoder->bytes) return AVERROR_EOF;
    if (++decoder->reads > MAX_CALLS) return io_failure(AUR_LIMIT, AVERROR(ENOMEM));
    uint32_t wanted = (uint32_t)count;
    if (wanted > MAX_READ) wanted = MAX_READ;
    if (wanted > decoder->bytes - decoder->position) wanted = decoder->bytes - decoder->position;
    decoder->read_bytes += wanted;
    if (decoder->read_bytes > (uint64_t)decoder->bytes * 8 + MAX_METADATA) return io_failure(AUR_LIMIT, AVERROR(ENOMEM));
    int received = aurialis_read(decoder->position, buffer, wanted);
    if (received < 0 || (uint32_t)received != wanted) return io_failure(AUR_DECODE, AVERROR(EIO));
    decoder->position += (uint32_t)received;
    return received;
}
static int64_t seek_packet(void *opaque, int64_t offset, int whence) {
    Decoder *decoder = opaque;
    if (decoder->failed) return AVERROR(EIO);
    whence &= ~AVSEEK_FORCE;
    if (++decoder->seeks > MAX_SEEKS) return io_failure(AUR_LIMIT, AVERROR(ENOMEM));
    if (whence == AVSEEK_SIZE) return decoder->bytes;
    int64_t base;
    if (whence == SEEK_SET) base = 0;
    else if (whence == SEEK_CUR) base = decoder->position;
    else if (whence == SEEK_END) base = decoder->bytes;
    else return io_failure(AUR_DECODE, AVERROR(EINVAL));
    if (offset < -base || offset > (int64_t)decoder->bytes - base) return io_failure(AUR_DECODE, AVERROR(EINVAL));
    decoder->position = (uint32_t)(base + offset);
    return decoder->position;
}
static int deny_secondary(AVFormatContext *format, AVIOContext **io,
                          const char *url, int flags, AVDictionary **options) {
    (void)format; (void)io; (void)url; (void)flags; (void)options;
    return io_failure(AUR_UNSUPPORTED, AVERROR(EACCES));
}
static int metadata_bytes(size_t bytes, size_t *total) {
    if (*total > MAX_METADATA || bytes > MAX_METADATA - *total) return 0;
    *total += bytes;
    return 1;
}
static int dictionary_bytes(AVDictionary *dictionary, size_t *total) {
    const AVDictionaryEntry *entry = NULL;
    while ((entry = av_dict_get(dictionary, "", entry, AV_DICT_IGNORE_SUFFIX))) {
        size_t key = strnlen(entry->key, MAX_METADATA + 1);
        size_t value = strnlen(entry->value, MAX_METADATA + 1);
        if (!metadata_bytes(key, total) || !metadata_bytes(value, total)) return 0;
    }
    return 1;
}
static int stream_policy(size_t *metadata_out) {
    /* Deliberately reject attached-picture streams as well as multiple audio
     * streams in this first format profile. No silent stream selection. */
    if (state.format->nb_streams != 1) return 0;
    const AVStream *stream = state.format->streams[0];
    const AVCodecParameters *parameters = stream->codecpar;
    if (parameters->codec_type != AVMEDIA_TYPE_AUDIO || parameters->extradata_size < 0 ||
        parameters->extradata_size > (int)MAX_METADATA || parameters->codec_tag == MKTAG('e','n','c','a') ||
        parameters->codec_tag == MKTAG('e','n','c','v')) return 0;
    size_t metadata = (size_t)parameters->extradata_size;
    for (int index = 0; index < parameters->nb_coded_side_data; index++) {
        enum AVPacketSideDataType kind = parameters->coded_side_data[index].type;
        if (!metadata_bytes(parameters->coded_side_data[index].size, &metadata) ||
            kind == AV_PKT_DATA_ENCRYPTION_INIT_INFO || kind == AV_PKT_DATA_ENCRYPTION_INFO) return 0;
    }
    switch (parameters->codec_id) {
        case AV_CODEC_ID_MP3: case AV_CODEC_ID_FLAC: case AV_CODEC_ID_VORBIS:
        case AV_CODEC_ID_AAC: case AV_CODEC_ID_ALAC: case AV_CODEC_ID_OPUS: break;
        default: return 0;
    }
    if (!dictionary_bytes(state.format->metadata, &metadata) || !dictionary_bytes(stream->metadata, &metadata)) return 0;
    if (metadata_out) *metadata_out = metadata;
    return 1;
}
void aurialis_decoder_close(void) {
    av_packet_free(&state.packet);
    av_frame_free(&state.frame);
    avcodec_free_context(&state.codec);
    avformat_close_input(&state.format);
    if (state.io) {
        av_freep(&state.io->buffer);
        avio_context_free(&state.io);
    }
    memset(&state, 0, sizeof(state));
}
int aurialis_decoder_abi(void) { return AURIALIS_DECODER_ABI; }
int aurialis_decoder_open(uint32_t format, uint32_t bytes, uint32_t max_frames) {
    if (state.opened || state.failed) return fail(AUR_STATE);
    if (!bytes || bytes > MAX_INPUT || !max_frames || max_frames > MAX_FRAMES) return fail(AUR_INVALID);
    const char *name;
    switch (format) {
        case AUR_MP3: name = "mp3"; break;
        case AUR_FLAC: name = "flac"; break;
        case AUR_OGG: name = "ogg"; break;
        case AUR_ADTS: name = "aac"; break;
        case AUR_MP4: name = "mov"; break;
        default: return fail(AUR_UNSUPPORTED);
    }
    state.bytes = bytes; state.max_frames = max_frames;
    av_max_alloc(MAX_SINGLE_ALLOC);
    av_log_set_level(AV_LOG_QUIET);
    uint8_t *buffer = av_malloc(MAX_READ);
    if (!buffer) return fail(AUR_LIMIT);
    state.io = avio_alloc_context(buffer, MAX_READ, 0, &state, read_packet, NULL, seek_packet);
    if (!state.io) { av_free(buffer); return fail(AUR_LIMIT); }
    state.format = avformat_alloc_context();
    if (!state.format) return fail(AUR_LIMIT);
    state.format->pb = state.io;
    state.format->flags |= AVFMT_FLAG_CUSTOM_IO;
    state.format->io_open = deny_secondary;
    state.format->probesize = MAX_READ;
    state.format->format_probesize = MAX_READ;
    state.format->max_analyze_duration = 1000000;
    state.format->max_probe_packets = 32;
    state.format->max_streams = 1;
    AVDictionary *options = NULL;
    av_dict_set(&options, "protocol_whitelist", "", 0);
    av_dict_set(&options, "format_whitelist", name, 0);
    int result = avformat_open_input(&state.format, NULL, av_find_input_format(name), &options);
    av_dict_free(&options);
    if (state.failed) return state.failed;
    if (result < 0 || !state.format) return fail(AUR_DECODE);
    /* This intentionally avoids unbounded find_stream_info. Formats whose
     * headers do not identify their one audio codec are unsupported here. */
    if (!stream_policy(NULL)) return fail(AUR_UNSUPPORTED);
    const AVCodec *codec = avcodec_find_decoder(state.format->streams[0]->codecpar->codec_id);
    if (!codec) return fail(AUR_UNSUPPORTED);
    state.codec = avcodec_alloc_context3(codec);
    if (!state.codec) return fail(AUR_LIMIT);
    if (avcodec_parameters_to_context(state.codec, state.format->streams[0]->codecpar) < 0) return fail(AUR_DECODE);
    state.codec->thread_count = 1;
    state.codec->thread_type = 0;
    state.codec->err_recognition = AV_EF_CRCCHECK | AV_EF_BITSTREAM | AV_EF_BUFFER | AV_EF_EXPLODE;
    if (avcodec_open2(state.codec, codec, NULL) < 0) return fail(AUR_DECODE);
    state.packet = av_packet_alloc(); state.frame = av_frame_alloc();
    if (!state.packet || !state.frame) return fail(AUR_LIMIT);
    state.opened = 1;
    return 0;
}
static int frame_policy(void) {
    AVFrame *frame = state.frame;
    int channels = frame->ch_layout.nb_channels, rate = frame->sample_rate;
    if ((channels != 1 && channels != 2) || rate < 8000 || rate > 192000 || frame->nb_samples <= 0 ||
        (frame->flags & AV_FRAME_FLAG_CORRUPT) || frame->decode_error_flags) return fail(AUR_UNSUPPORTED);
    AVChannelLayout expected = {0};
    av_channel_layout_default(&expected, channels);
    int layout_ok = av_channel_layout_compare(&expected, &frame->ch_layout) == 0;
    av_channel_layout_uninit(&expected);
    if (!layout_ok || (state.codec->codec_id == AV_CODEC_ID_AAC &&
        state.codec->profile != AV_PROFILE_AAC_LOW && state.codec->profile != AV_PROFILE_AAC_HE &&
        state.codec->profile != AV_PROFILE_AAC_HE_V2))
        return fail(AUR_UNSUPPORTED);
    if (state.rate && (state.rate != (uint32_t)rate || state.channels != (uint32_t)channels)) return fail(AUR_UNSUPPORTED);
    if ((uint32_t)frame->nb_samples > state.max_frames - state.frames) return fail(AUR_LIMIT);
    state.rate = (uint32_t)rate; state.channels = (uint32_t)channels;
    state.frames += (uint32_t)frame->nb_samples;
    state.frame_offset = 0;
    return 0;
}
static int packet_policy(void) {
    /* One aggregate budget includes stream extradata/dictionaries/coded side
     * payloads and the current packet's side payloads, with checked addition. */
    size_t metadata = 0;
    if (!stream_policy(&metadata) || state.packet->stream_index != 0 ||
        (state.packet->flags & AV_PKT_FLAG_CORRUPT) || state.packet->size < 0 ||
        state.packet->size > (int)MAX_SINGLE_ALLOC) return 0;
    for (int index = 0; index < state.packet->side_data_elems; index++) {
        enum AVPacketSideDataType kind = state.packet->side_data[index].type;
        if (!metadata_bytes(state.packet->side_data[index].size, &metadata) ||
            kind == AV_PKT_DATA_ENCRYPTION_INFO || kind == AV_PKT_DATA_ENCRYPTION_INIT_INFO ||
            kind == AV_PKT_DATA_NEW_EXTRADATA || kind == AV_PKT_DATA_PARAM_CHANGE) return 0;
    }
    return 1;
}
static int receive_frame(void) {
    av_frame_unref(state.frame);
    for (;;) {
        int result = avcodec_receive_frame(state.codec, state.frame);
        if (state.failed) return state.failed;
        if (result == 0) return frame_policy();
        if (result == AVERROR_EOF) { state.eof = 1; return 0; }
        if (result != AVERROR(EAGAIN)) return fail(AUR_DECODE);
        if (state.pending_packet) {
            result = avcodec_send_packet(state.codec, state.packet);
            if (state.failed) return state.failed;
            if (result == AVERROR(EAGAIN)) return fail(AUR_DECODE);
            av_packet_unref(state.packet); state.pending_packet = 0;
            if (result < 0) return fail(AUR_DECODE);
            continue;
        }
        if (state.draining) return fail(AUR_DECODE);
        if (++state.packets > MAX_PACKETS) return fail(AUR_LIMIT);
        result = av_read_frame(state.format, state.packet);
        if (state.failed) return state.failed;
        if (result == AVERROR_EOF) {
            state.draining = 1;
            result = avcodec_send_packet(state.codec, NULL);
            if (state.failed) return state.failed;
            if (result < 0) return fail(AUR_DECODE);
        } else {
            if (result < 0) return fail(AUR_DECODE);
            if (!packet_policy()) return fail(AUR_UNSUPPORTED);
            state.pending_packet = 1;
        }
    }
}
static float sample_at(enum AVSampleFormat format, const uint8_t *data, uint32_t index) {
    switch (format) {
        case AV_SAMPLE_FMT_U8: return ((int)data[index] - 128) / 128.0f;
        case AV_SAMPLE_FMT_S16: return ((const int16_t *)data)[index] / 32768.0f;
        case AV_SAMPLE_FMT_S32: return (float)(((const int32_t *)data)[index] / 2147483648.0);
        case AV_SAMPLE_FMT_S64: return (float)(((const int64_t *)data)[index] / 9223372036854775808.0);
        case AV_SAMPLE_FMT_FLT: return ((const float *)data)[index];
        case AV_SAMPLE_FMT_DBL: return (float)((const double *)data)[index];
        default: return NAN;
    }
}
int aurialis_decoder_next(void) {
    if (state.failed) return state.failed;
    if (!state.opened) return fail(AUR_STATE);
    if (state.eof) return state.frames ? 0 : fail(AUR_DECODE);
    if (state.frame_offset >= (uint32_t)state.frame->nb_samples) {
        if (receive_frame() < 0) return state.failed;
        if (state.eof) return state.frames ? 0 : fail(AUR_DECODE);
    }
    uint32_t frames = (uint32_t)state.frame->nb_samples - state.frame_offset;
    if (frames > AURIALIS_CHUNK_FRAMES) frames = AURIALIS_CHUNK_FRAMES;
    enum AVSampleFormat format = (enum AVSampleFormat)state.frame->format;
    int planar = av_sample_fmt_is_planar(format);
    enum AVSampleFormat packed = av_get_packed_sample_fmt(format);
    for (uint32_t frame = 0; frame < frames; frame++) {
        for (uint32_t channel = 0; channel < 2; channel++) {
            uint32_t input = state.channels == 1 ? 0 : channel;
            uint32_t index = planar ? state.frame_offset + frame : (state.frame_offset + frame) * state.channels + input;
            const uint8_t *data = state.frame->extended_data[planar ? input : 0];
            if (!data) return fail(AUR_DECODE);
            float sample = sample_at(packed, data, index);
            if (!isfinite(sample)) return fail(AUR_DECODE);
            state.output[frame * 2 + channel] = sample;
        }
    }
    state.frame_offset += frames;
    return (int)frames;
}
const float *aurialis_decoder_output(void) { return state.output; }
uint32_t aurialis_decoder_rate(void) { return state.rate; }
uint32_t aurialis_decoder_channels(void) { return state.channels; }
uint32_t aurialis_decoder_frames(void) { return state.frames; }
