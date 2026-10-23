/* Test-only inclusion of the actual wrapper. Every parse/decode entrypoint is
 * linker-wrapped below. No encoded input, audio codec or demuxer executes. */
#include "../decoder.c"

enum FixtureMode {
    FIXTURE_NORMAL, FIXTURE_OPEN_LIMIT, FIXTURE_OPEN_SHORT,
    FIXTURE_READ_IO_EOF, FIXTURE_READ_LIMIT_EOF, FIXTURE_RECEIVE_EOF,
    FIXTURE_RECEIVE_SUCCESS, FIXTURE_RECEIVE_ERROR, FIXTURE_READ_SUCCESS,
    FIXTURE_METADATA
};
static int fixture_mode, read_kind, receive_calls, codec_open_calls;

int aurialis_read(uint32_t offset, uint8_t *destination, uint32_t bytes) {
    (void)offset;
    if (read_kind == 1) return -1;
    if (read_kind == 2) return (int)bytes - 1;
    memset(destination, 0, bytes);
    return (int)bytes;
}
static int fixture_stream(void) {
    AVStream *stream = avformat_new_stream(state.format, NULL);
    if (!stream) return 0;
    stream->codecpar->codec_type = AVMEDIA_TYPE_AUDIO;
    stream->codecpar->codec_id = AV_CODEC_ID_FLAC;
    stream->codecpar->sample_rate = 48000;
    av_channel_layout_default(&stream->codecpar->ch_layout, 2);
    return 1;
}
int __wrap_avformat_open_input(AVFormatContext **format, const char *url,
                               const AVInputFormat *input, AVDictionary **options) {
    (void)format; (void)url; (void)input; (void)options;
    if (!fixture_stream()) return AVERROR(ENOMEM);
    uint8_t buffer[8];
    if (fixture_mode == FIXTURE_OPEN_LIMIT) state.reads = MAX_CALLS;
    if (fixture_mode == FIXTURE_OPEN_SHORT) read_kind = 2;
    read_packet(&state, buffer, 8);
    return fixture_mode == FIXTURE_OPEN_SHORT ? AVERROR_EOF : 0;
}
int __wrap_avcodec_open2(AVCodecContext *codec, const AVCodec *implementation, AVDictionary **options) {
    (void)codec; (void)implementation; (void)options;
    codec_open_calls++;
    return 0;
}
int __wrap_avcodec_receive_frame(AVCodecContext *codec, AVFrame *frame) {
    (void)codec;
    receive_calls++;
    if (fixture_mode == FIXTURE_RECEIVE_EOF) { fail(AUR_LIMIT); return AVERROR_EOF; }
    if (fixture_mode == FIXTURE_RECEIVE_ERROR) { fail(AUR_LIMIT); return AVERROR_INVALIDDATA; }
    if (fixture_mode == FIXTURE_RECEIVE_SUCCESS) {
        fail(AUR_UNSUPPORTED);
        frame->nb_samples = 1; frame->sample_rate = 48000; frame->format = AV_SAMPLE_FMT_FLT;
        av_channel_layout_default(&frame->ch_layout, 2);
        return 0;
    }
    return receive_calls == 1 ? AVERROR(EAGAIN) : AVERROR_EOF;
}
int __wrap_avcodec_send_packet(AVCodecContext *codec, const AVPacket *packet) {
    (void)codec; (void)packet;
    return 0;
}
int __wrap_av_read_frame(AVFormatContext *format, AVPacket *packet) {
    (void)format; (void)packet;
    uint8_t buffer[8];
    if (fixture_mode == FIXTURE_READ_SUCCESS) { fail(AUR_LIMIT); return 0; }
    if (fixture_mode == FIXTURE_METADATA) return 0;
    if (fixture_mode == FIXTURE_READ_IO_EOF) read_kind = 1;
    if (fixture_mode == FIXTURE_READ_LIMIT_EOF) state.reads = MAX_CALLS;
    if (fixture_mode == FIXTURE_READ_IO_EOF || fixture_mode == FIXTURE_READ_LIMIT_EOF)
        read_packet(&state, buffer, 8);
    return AVERROR_EOF;
}
static int prefix(void) {
    state.format = avformat_alloc_context(); state.codec = avcodec_alloc_context3(NULL);
    state.packet = av_packet_alloc(); state.frame = av_frame_alloc();
    if (!state.format || !state.codec || !state.packet || !state.frame || !fixture_stream()) return 0;
    state.codec->codec_id = AV_CODEC_ID_FLAC;
    state.opened = 1; state.bytes = 64; state.max_frames = 16; state.frames = 1;
    state.rate = 48000; state.channels = 2;
    uint8_t buffer[8];
    return read_packet(&state, buffer, 8) == 8;
}
static int extra_bytes(size_t bytes) {
    AVCodecParameters *parameters = state.format->streams[0]->codecpar;
    parameters->extradata = av_mallocz(bytes + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!parameters->extradata) return 0;
    parameters->extradata_size = (int)bytes;
    return 1;
}
static int packet_side(size_t bytes) {
    return av_packet_new_side_data(state.packet, AV_PKT_DATA_STRINGS_METADATA, bytes) != NULL;
}
static int coded_sides(size_t first, size_t second) {
    AVCodecParameters *parameters = state.format->streams[0]->codecpar;
    parameters->coded_side_data = av_calloc(2, sizeof(*parameters->coded_side_data));
    if (!parameters->coded_side_data) return 0;
    parameters->nb_coded_side_data = 2;
    parameters->coded_side_data[0].type = AV_PKT_DATA_STRINGS_METADATA;
    parameters->coded_side_data[1].type = AV_PKT_DATA_METADATA_UPDATE;
    parameters->coded_side_data[0].size = first;
    parameters->coded_side_data[1].size = second;
    /* Size-only overflow fixtures intentionally have no giant allocation. */
    if (first <= MAX_METADATA) parameters->coded_side_data[0].data = av_mallocz(first ? first : 1);
    if (second <= MAX_METADATA) parameters->coded_side_data[1].data = av_mallocz(second ? second : 1);
    return (first > MAX_METADATA || parameters->coded_side_data[0].data) &&
           (second > MAX_METADATA || parameters->coded_side_data[1].data);
}
int aurialis_test_count(void) { return 22; }
int aurialis_test_case(int index) {
    aurialis_decoder_close();
    fixture_mode = FIXTURE_NORMAL; read_kind = 0; receive_calls = 0; codec_open_calls = 0;
    int passed = 0, result = 0;
    uint8_t buffer[8];
    state.bytes = 64;
    switch (index) {
        case 0:
            state.position = state.bytes;
            passed = read_packet(&state, buffer, 8) == AVERROR_EOF && state.failed == 0;
            break;
        case 1:
            state.position = state.bytes + 1;
            passed = read_packet(&state, buffer, 8) == AVERROR(EINVAL) && state.failed == AUR_DECODE;
            break;
        case 2:
            read_kind = 2;
            passed = read_packet(&state, buffer, 8) == AVERROR(EIO) && state.failed == AUR_DECODE && state.position == 0;
            break;
        case 3:
            passed = seek_packet(&state, 0, AVSEEK_SIZE | AVSEEK_FORCE) == 64 && state.failed == 0;
            break;
        case 4:
            passed = seek_packet(&state, -1, SEEK_SET) == AVERROR(EINVAL) && state.failed == AUR_DECODE;
            break;
        case 5:
            state.seeks = MAX_SEEKS;
            passed = seek_packet(&state, 0, SEEK_SET) == AVERROR(ENOMEM) && state.failed == AUR_LIMIT;
            break;
        case 6:
            passed = deny_secondary(NULL, NULL, "fixture-denied", 0, NULL) == AVERROR(EACCES) &&
                     fail(AUR_DECODE) == AUR_UNSUPPORTED;
            break;
        case 7:
            state.bytes = 0; fixture_mode = FIXTURE_OPEN_LIMIT;
            result = aurialis_decoder_open(AUR_MP3, 64, 16);
            passed = result == AUR_LIMIT && !state.opened && codec_open_calls == 0;
            break;
        case 8:
            state.bytes = 0; fixture_mode = FIXTURE_OPEN_SHORT;
            result = aurialis_decoder_open(AUR_MP3, 64, 16);
            passed = result == AUR_DECODE && !state.opened && codec_open_calls == 0;
            break;
        case 9: case 10: case 11: case 12: case 13: case 14:
            if (!prefix()) break;
            fixture_mode = index == 9 ? FIXTURE_READ_IO_EOF : index == 10 ? FIXTURE_READ_LIMIT_EOF :
                           index == 11 ? FIXTURE_RECEIVE_EOF : index == 12 ? FIXTURE_RECEIVE_SUCCESS :
                           index == 13 ? FIXTURE_RECEIVE_ERROR : FIXTURE_READ_SUCCESS;
            result = aurialis_decoder_next();
            passed = result == (index == 9 ? AUR_DECODE : index == 12 ? AUR_UNSUPPORTED : AUR_LIMIT) &&
                     !state.eof && state.frames == 1 && !state.pending_packet && !state.draining;
            break;
        case 15:
            if (!prefix() || !coded_sides(600 * 1024, 500 * 1024)) break;
            fixture_mode = FIXTURE_METADATA;
            passed = aurialis_decoder_next() == AUR_UNSUPPORTED && !state.eof && state.frames == 1;
            break;
        case 16:
            if (!prefix() || !extra_bytes(600 * 1024) || !packet_side(500 * 1024)) break;
            fixture_mode = FIXTURE_METADATA;
            passed = aurialis_decoder_next() == AUR_UNSUPPORTED && !state.eof && state.frames == 1;
            break;
        case 17:
            if (!prefix() || !extra_bytes(MAX_METADATA / 2) || !packet_side(MAX_METADATA / 2)) break;
            passed = packet_policy() == 1 && state.failed == 0;
            break;
        case 18:
            if (!prefix() || !coded_sides(SIZE_MAX, 0)) break;
            passed = packet_policy() == 0;
            break;
        case 19:
            if (!prefix()) break;
            passed = aurialis_decoder_next() == 0 && state.eof && state.frames == 1 && state.failed == 0;
            break;
        case 20:
            fail(AUR_LIMIT); state.position = state.bytes;
            passed = read_packet(&state, buffer, 8) == AVERROR(EIO) && fail(AUR_DECODE) == AUR_LIMIT;
            break;
        case 21:
            if (!prefix() || !extra_bytes(MAX_METADATA - 3)) break;
            av_dict_set(&state.format->metadata, "a", "bbb", 0);
            fixture_mode = FIXTURE_METADATA;
            passed = aurialis_decoder_next() == AUR_UNSUPPORTED && !state.eof && state.frames == 1;
            break;
        default: break;
    }
    aurialis_decoder_close();
    return passed ? 0 : index + 1;
}
