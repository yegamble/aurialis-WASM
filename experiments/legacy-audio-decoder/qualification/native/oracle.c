/* Private diagnostic oracle. Independent collection/conversion path; never
 * includes decoder.c and never linked into the application or runtime core.
 * Only generated, hash-recorded fixture files may be passed by the test driver.
 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>

#define INPUT_MAX (16U * 1024U * 1024U)
#define TRACE_MAX (8U * 1024U * 1024U)
#define FRAMES_MAX 384001U
#define WORK_MAX 16384U
#define IO_BYTES 65536U
static struct {
    int input, output, failed, library_error;
    FILE *trace;
    uint32_t bytes, position, reads, seeks, packets, frame_calls, frames, rate, channels, trace_bytes;
    uint64_t read_bytes;
    float peak[2];
    uint32_t peak_at[2], negative_zero[2];
} run;
static int trace(const char *format, ...) {
    char line[2048];
    va_list args;
    va_start(args, format);
    int bytes = vsnprintf(line, sizeof(line), format, args);
    va_end(args);
    if (!run.trace || bytes < 0 || bytes >= (int)sizeof(line) || (uint32_t)bytes > TRACE_MAX - run.trace_bytes) return 0;
    if (fwrite(line, 1, (size_t)bytes, run.trace) != (size_t)bytes) return 0;
    run.trace_bytes += (uint32_t)bytes;
    return 1;
}
static int io_error(int error) { run.failed = 1; if (!run.library_error) run.library_error = error; return error; }
static int read_input(void *opaque, uint8_t *destination, int requested) {
    (void)opaque;
    if (run.failed || requested <= 0 || run.position > run.bytes) { return io_error(AVERROR(EIO)); }
    if (run.position == run.bytes) return AVERROR_EOF;
    uint32_t wanted = (uint32_t)requested;
    if (wanted > IO_BYTES) wanted = IO_BYTES;
    if (wanted > run.bytes - run.position) wanted = run.bytes - run.position;
    if (++run.reads > WORK_MAX || run.read_bytes + wanted > (uint64_t)run.bytes * 8U + 1048576U) { return io_error(AVERROR(ENOMEM)); }
    run.read_bytes += wanted;
    ssize_t got;
    do { got = pread(run.input, destination, wanted, (off_t)run.position); } while (got < 0 && errno == EINTR);
    if (got != (ssize_t)wanted) { return io_error(AVERROR(EIO)); }
    run.position += wanted;
    return (int)wanted;
}
static int64_t seek_input(void *opaque, int64_t offset, int whence) {
    (void)opaque;
    if (run.failed || ++run.seeks > WORK_MAX) { return io_error(AVERROR(EIO)); }
    whence &= ~AVSEEK_FORCE;
    if (whence == AVSEEK_SIZE) return run.bytes;
    int64_t base = -1;
    if (whence == SEEK_SET) base = 0;
    else if (whence == SEEK_CUR) base = (int64_t)run.position;
    else if (whence == SEEK_END) base = (int64_t)run.bytes;
    if (base < 0 || offset < -base || offset > (int64_t)run.bytes - base) { return io_error(AVERROR(EINVAL)); }
    run.position = (uint32_t)(base + offset);
    return run.position;
}
static int deny_open(AVFormatContext *format, AVIOContext **io, const char *url, int flags, AVDictionary **options) {
    (void)format; (void)io; (void)url; (void)flags; (void)options;
    return io_error(AVERROR(EACCES));
}
static int allowed_codec(enum AVCodecID codec) {
    return codec == AV_CODEC_ID_AAC || codec == AV_CODEC_ID_ALAC || codec == AV_CODEC_ID_FLAC ||
           codec == AV_CODEC_ID_MP3 || codec == AV_CODEC_ID_OPUS || codec == AV_CODEC_ID_VORBIS;
}
static int convert(const unsigned char *address, enum AVSampleFormat kind, float *result) {
    /* memcpy avoids type-punning/alignment assumptions; conversion has no
     * normalization, clipping, dither, rate conversion or channel processing. */
    switch (kind) {
        case AV_SAMPLE_FMT_U8: *result = ((float)*address - 128.0f) * 0x1p-7f; break;
        case AV_SAMPLE_FMT_S16: { int16_t value; memcpy(&value, address, 2); *result = (float)value * 0x1p-15f; break; }
        case AV_SAMPLE_FMT_S32: { int32_t value; memcpy(&value, address, 4); *result = (float)((double)value * 0x1p-31); break; }
        case AV_SAMPLE_FMT_S64: { int64_t value; memcpy(&value, address, 8); *result = (float)((double)value * 0x1p-63); break; }
        case AV_SAMPLE_FMT_FLT: memcpy(result, address, 4); break;
        case AV_SAMPLE_FMT_DBL: { double value; memcpy(&value, address, 8); *result = (float)value; break; }
        default: return 0;
    }
    return isfinite(*result);
}
static int write_pcm(const unsigned char *bytes, size_t count) {
    while (count) {
        ssize_t written = write(run.output, bytes, count);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 0;
        bytes += (size_t)written; count -= (size_t)written;
    }
    return 1;
}
static void printable(char *text) {
    for (unsigned char *p = (unsigned char *)text; *p; p++) if (*p < 32 || *p > 126 || *p == '"' || *p == '\\') *p = '?';
}
static int collect(AVCodecContext *decoder, const AVFrame *frame) {
    uint32_t channels = (uint32_t)frame->ch_layout.nb_channels;
    if ((channels != 1 && channels != 2) || frame->sample_rate < 8000 || frame->sample_rate > 192000 ||
        frame->nb_samples <= 0 || (uint32_t)frame->nb_samples > FRAMES_MAX - run.frames ||
        (run.frames && (channels != run.channels || (uint32_t)frame->sample_rate != run.rate))) return 0;
    char layout[128];
    int length = av_channel_layout_describe(&frame->ch_layout, layout, sizeof(layout));
    if (length < 0 || length >= (int)sizeof(layout)) return 0;
    printable(layout);
    enum AVSampleFormat source = (enum AVSampleFormat)frame->format;
    enum AVSampleFormat packed = av_get_packed_sample_fmt(source);
    int width = av_get_bytes_per_sample(source), planar = av_sample_fmt_is_planar(source);
    if (width < 1 || width > 8 || ++run.frame_calls > WORK_MAX) return 0;
    if (!trace("{\"kind\":\"frame\",\"index\":%u,\"offset\":%u,\"frames\":%d,\"rate\":%d,\"channels\":%u,\"layout\":\"%s\",\"sampleFormat\":%d,\"profile\":%d,\"flags\":%d,\"decodeErrorFlags\":%d}\n",
        run.frame_calls, run.frames, frame->nb_samples, frame->sample_rate, channels, layout, frame->format, decoder->profile, frame->flags, frame->decode_error_flags)) return 0;
    if ((frame->flags & AV_FRAME_FLAG_CORRUPT) || frame->decode_error_flags) return 0;
    unsigned char block[4096U * 2U * 4U];
    uint32_t done = 0;
    while (done < (uint32_t)frame->nb_samples) {
        uint32_t count = (uint32_t)frame->nb_samples - done;
        if (count > 4096U) count = 4096U;
        for (uint32_t sample = 0; sample < count; sample++) {
            for (uint32_t channel = 0; channel < channels; channel++) {
                unsigned plane = planar ? channel : 0;
                uint32_t at = planar ? done + sample : (done + sample) * channels + channel;
                if (!frame->extended_data || !frame->extended_data[plane]) return 0;
                float value;
                if (!convert(frame->extended_data[plane] + (size_t)at * (size_t)width, packed, &value)) return 0;
                if (value == 0 && signbit(value)) run.negative_zero[channel]++;
                if (fabsf(value) > run.peak[channel]) { run.peak[channel] = fabsf(value); run.peak_at[channel] = run.frames + done + sample; }
                uint32_t bits; memcpy(&bits, &value, 4);
                unsigned char *target = block + (sample * channels + channel) * 4U;
                target[0] = (unsigned char)bits; target[1] = (unsigned char)(bits >> 8);
                target[2] = (unsigned char)(bits >> 16); target[3] = (unsigned char)(bits >> 24);
            }
        }
        if (!write_pcm(block, (size_t)count * channels * 4U)) return 0;
        done += count;
    }
    run.rate = (uint32_t)frame->sample_rate; run.channels = channels; run.frames += (uint32_t)frame->nb_samples;
    return 1;
}
static int drain(AVCodecContext *decoder, AVFrame *frame, int *ended) {
    for (;;) {
        int result = avcodec_receive_frame(decoder, frame);
        if (run.failed) return 0;
        if (result == AVERROR(EAGAIN)) return 1;
        if (result == AVERROR_EOF) { *ended = 1; return 1; }
        if (result < 0) { if (!run.library_error) run.library_error = result; return 0; }
        if (!collect(decoder, frame)) return 0;
        av_frame_unref(frame);
    }
}
static uint32_t little32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static int dictionary_size(AVDictionary *dictionary, uint64_t *bytes) {
    const AVDictionaryEntry *entry = NULL;
    while ((entry = av_dict_get(dictionary, "", entry, AV_DICT_IGNORE_SUFFIX))) {
        size_t key = strnlen(entry->key, 1048577U), value = strnlen(entry->value, 1048577U);
        if (key > 1048576U || value > 1048576U || key > UINT64_MAX - *bytes) return 0;
        *bytes += key;
        if (value > UINT64_MAX - *bytes) return 0;
        *bytes += value;
    }
    return 1;
}
static int packet_trace(const AVPacket *packet) {
    uint32_t skip = 0, discard = 0;
    uint64_t metadata = 0;
    for (int i = 0; i < packet->side_data_elems; i++) {
        size_t size = packet->side_data[i].size;
        if (size > UINT64_MAX - metadata) return 0;
        metadata += size;
        if (packet->side_data[i].type == AV_PKT_DATA_SKIP_SAMPLES) {
            if (size < 10) return 0;
            skip = little32(packet->side_data[i].data); discard = little32(packet->side_data[i].data + 4);
        }
    }
    return trace("{\"kind\":\"packet\",\"index\":%u,\"bytes\":%d,\"flags\":%d,\"pts\":\"%" PRId64 "\",\"duration\":\"%" PRId64 "\",\"skip\":%u,\"discard\":%u,\"sideDataBytes\":%" PRIu64 "}\n", run.packets, packet->size, packet->flags, packet->pts, packet->duration, skip, discard, metadata);
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("avcodec=%u avformat=%u avutil=%u\n%s\n", avcodec_version(), avformat_version(), avutil_version(), avcodec_configuration()); return 0;
    }
    if (argc != 5 || (strcmp(argv[1], "mp3") && strcmp(argv[1], "flac") && strcmp(argv[1], "ogg") && strcmp(argv[1], "aac") && strcmp(argv[1], "mov"))) return 2;
    memset(&run, 0, sizeof(run)); run.input = -1; run.output = -1;
    AVFormatContext *format = NULL;
    AVCodecContext *decoder = NULL;
    AVIOContext *io = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    AVDictionary *options = NULL;
    int status = 1, created = 0, ended = 0, result = 0, tracefd = -1;
    struct stat before, after;
    run.input = open(argv[2], O_RDONLY | O_NOFOLLOW);
    if (run.input < 0 || fstat(run.input, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 12 || before.st_size > INPUT_MAX) goto cleanup;
    run.bytes = (uint32_t)before.st_size;
    run.output = open(argv[3], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (run.output < 0) goto cleanup;
    created = 1;
    tracefd = open(argv[4], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (tracefd < 0 || !(run.trace = fdopen(tracefd, "w"))) goto cleanup;
    tracefd = -1;
    av_max_alloc(8U * 1024U * 1024U); av_log_set_level(AV_LOG_ERROR);
    uint8_t *buffer = av_malloc(IO_BYTES);
    if (!buffer) goto cleanup;
    io = avio_alloc_context(buffer, IO_BYTES, 0, NULL, read_input, NULL, seek_input);
    if (!io) { av_free(buffer); goto cleanup; }
    format = avformat_alloc_context();
    if (!format) goto cleanup;
    format->pb = io; format->flags |= AVFMT_FLAG_CUSTOM_IO; format->io_open = deny_open;
    format->probesize = IO_BYTES; format->format_probesize = IO_BYTES;
    format->max_analyze_duration = 1000000; format->max_probe_packets = 32; format->max_streams = 1;
    av_dict_set(&options, "protocol_whitelist", "", 0); av_dict_set(&options, "format_whitelist", argv[1], 0);
    result = avformat_open_input(&format, NULL, av_find_input_format(argv[1]), &options);
    av_dict_free(&options);
    if (run.failed || result < 0 || !format || format->nb_streams != 1) goto cleanup;
    const AVCodecParameters *parameters = format->streams[0]->codecpar;
    if (parameters->codec_type != AVMEDIA_TYPE_AUDIO || !allowed_codec(parameters->codec_id)) goto cleanup;
    const AVCodec *codec = avcodec_find_decoder(parameters->codec_id);
    if (!codec || !(decoder = avcodec_alloc_context3(codec)) || avcodec_parameters_to_context(decoder, parameters) < 0) goto cleanup;
    decoder->thread_count = 1; decoder->thread_type = 0;
    decoder->err_recognition = AV_EF_CRCCHECK | AV_EF_BITSTREAM | AV_EF_BUFFER | AV_EF_EXPLODE;
    result = avcodec_open2(decoder, codec, NULL);
    if (run.failed || result < 0) goto cleanup;
    uint64_t dictionary_bytes = 0, coded_side_bytes = 0;
    if (!dictionary_size(format->metadata, &dictionary_bytes) || !dictionary_size(format->streams[0]->metadata, &dictionary_bytes)) goto cleanup;
    for (int i = 0; i < parameters->nb_coded_side_data; i++) {
        size_t bytes = parameters->coded_side_data[i].size;
        if (bytes > UINT64_MAX - coded_side_bytes) goto cleanup;
        coded_side_bytes += bytes;
    }
    if (!trace("{\"kind\":\"stream\",\"codecID\":%d,\"headerRate\":%d,\"headerChannels\":%d,\"profile\":%d,\"initialPadding\":%d,\"trailingPadding\":%d,\"extradataBytes\":%d,\"dictionaryBytes\":%" PRIu64 ",\"codedSideBytes\":%" PRIu64 "}\n", parameters->codec_id, parameters->sample_rate, parameters->ch_layout.nb_channels, parameters->profile, parameters->initial_padding, parameters->trailing_padding, parameters->extradata_size, dictionary_bytes, coded_side_bytes)) goto cleanup;
    packet = av_packet_alloc(); frame = av_frame_alloc();
    if (!packet || !frame) goto cleanup;
    for (;;) {
        if (++run.packets > WORK_MAX) goto cleanup;
        result = av_read_frame(format, packet);
        if (run.failed) goto cleanup;
        if (result == AVERROR_EOF) break;
        if (result < 0 || packet->stream_index != 0 || packet->size < 0 || !packet_trace(packet)) goto cleanup;
        result = avcodec_send_packet(decoder, packet);
        if (run.failed) goto cleanup;
        if (result == AVERROR(EAGAIN)) {
            if (!drain(decoder, frame, &ended) || ended) goto cleanup;
            result = avcodec_send_packet(decoder, packet);
        }
        if (run.failed || result < 0 || !drain(decoder, frame, &ended) || ended) goto cleanup;
        av_packet_unref(packet);
    }
    result = avcodec_send_packet(decoder, NULL);
    if (run.failed) goto cleanup;
    if (result == AVERROR(EAGAIN)) {
        if (!drain(decoder, frame, &ended) || ended) goto cleanup;
        result = avcodec_send_packet(decoder, NULL);
    }
    if (run.failed || result < 0 || !drain(decoder, frame, &ended) || !ended || !run.frames) goto cleanup;
    if (fstat(run.input, &after) != 0 || before.st_ino != after.st_ino || before.st_dev != after.st_dev || before.st_size != after.st_size ||
        before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec || before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec) goto cleanup;
    if (!trace("{\"kind\":\"complete\",\"frames\":%u,\"rate\":%u,\"channels\":%u,\"outputBytes\":%" PRIu64 ",\"profile\":%d,\"reads\":%u,\"seeks\":%u,\"readBytes\":%" PRIu64 ",\"peak\":[%.9g,%.9g],\"peakAt\":[%u,%u],\"negativeZero\":[%u,%u]}\n", run.frames, run.rate, run.channels, (uint64_t)run.frames * run.channels * 4U, decoder->profile, run.reads, run.seeks, run.read_bytes, run.peak[0], run.peak[1], run.peak_at[0], run.peak_at[1], run.negative_zero[0], run.negative_zero[1]) || fsync(run.output) != 0) goto cleanup;
    status = 0;
cleanup:
    if (status && run.trace) trace("{\"kind\":\"failure\",\"libraryResult\":%d,\"ioFailure\":%d,\"framesBeforeFailure\":%u}\n", run.library_error ? run.library_error : result, run.failed, run.frames);
    av_dict_free(&options); av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder); avformat_close_input(&format);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    if (run.input >= 0 && close(run.input) != 0) status = 1;
    if (run.output >= 0 && close(run.output) != 0) status = 1;
    if (run.trace && fclose(run.trace) != 0) status = 1;
    if (tracefd >= 0) close(tracefd);
    if (created && status) unlink(argv[3]);
    return status;
}
