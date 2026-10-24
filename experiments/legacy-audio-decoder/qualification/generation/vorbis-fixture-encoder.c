/* PRIVATE TEST-FIXTURE GENERATOR, never an application/request dependency.
 * Uses published Xiph APIs, reviewed against the official v1.3.7 example:
 * https://github.com/xiph/vorbis/blob/v1.3.7/examples/encoder_example.c
 * Retain Xiph's installed COPYING notices with the generator provenance.
 * Input is only our generated, hash-recorded interleaved Float32LE fixture.
 */
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vorbis/vorbisenc.h>

#define BLOCK 1024U
#define FRAME_LIMIT 384001U
#define OUTPUT_LIMIT (2U * 1024U * 1024U)
#define WORK_LIMIT 8192U
static uint32_t output_bytes, pages, packets, blocks;
static int eos;
static ogg_int64_t final_granule;

static int number(const char *text, uint32_t minimum, uint32_t maximum, uint32_t *value) {
    uint32_t result = 0;
    if (!*text) return 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p < '0' || *p > '9') return 0;
        uint32_t digit = (uint32_t)(*p - '0');
        if (result > maximum / 10U || (result == maximum / 10U && digit > maximum % 10U)) return 0;
        result = result * 10U + digit;
    }
    if (result < minimum || result > maximum) return 0;
    *value = result;
    return 1;
}
static int write_all(int descriptor, const unsigned char *data, size_t count) {
    while (count) {
        ssize_t written = write(descriptor, data, count);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 0;
        data += (size_t)written; count -= (size_t)written;
    }
    return 1;
}
static int page_write(int descriptor, const ogg_page *page) {
    if (eos || page->header_len < 27 || page->header_len > 282 || page->body_len < 0 || page->body_len > 65025 || ++pages > WORK_LIMIT) return 0;
    uint32_t count = (uint32_t)(page->header_len + page->body_len);
    if (count > OUTPUT_LIMIT - output_bytes) return 0;
    /* libogg owns these ranges only until the next packet/page/flush call. */
    if (!write_all(descriptor, page->header, (size_t)page->header_len) ||
        !write_all(descriptor, page->body, (size_t)page->body_len)) return 0;
    output_bytes += count;
    if (ogg_page_eos(page)) { eos = 1; final_granule = ogg_page_granulepos(page); }
    return 1;
}
static int page_drain(int descriptor, ogg_stream_state *stream, int flush) {
    ogg_page page;
    int result;
    while ((result = flush ? ogg_stream_flush(stream, &page) : ogg_stream_pageout(stream, &page)) != 0) {
        if (result < 0 || !page_write(descriptor, &page)) return 0;
    }
    return 1;
}
static int packet_add(ogg_stream_state *stream, ogg_packet *packet) {
    if (eos || ++packets > WORK_LIMIT || packet->bytes < 0 || packet->bytes > (long)OUTPUT_LIMIT) return 0;
    /* packetin copies the bytes; no retained borrowed header/packet pointers. */
    return ogg_stream_packetin(stream, packet) == 0;
}
static int analysis_drain(int descriptor, vorbis_dsp_state *dsp, vorbis_block *block, ogg_stream_state *stream) {
    int result;
    while ((result = vorbis_analysis_blockout(dsp, block)) == 1) {
        if (++blocks > WORK_LIMIT || vorbis_analysis(block, NULL) != 0 || vorbis_bitrate_addblock(block) != 0) return 0;
        ogg_packet packet;
        while ((result = vorbis_bitrate_flushpacket(dsp, &packet)) != 0) {
            if (result < 0 || !packet_add(stream, &packet) || !page_drain(descriptor, stream, 0)) return 0;
        }
    }
    return result == 0;
}
static int read_exact(int descriptor, unsigned char *data, size_t bytes) {
    while (bytes) {
        ssize_t count = read(descriptor, data, bytes);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        data += (size_t)count; bytes -= (size_t)count;
    }
    return 1;
}
int main(int argc, char **argv) {
    uint32_t channels, rate, frames;
    if (argc != 6 || !number(argv[3], 1, 2, &channels) || !number(argv[4], 8000, 192000, &rate) ||
        !number(argv[5], 1, FRAME_LIMIT, &frames) || frames > rate * 2U + 1U) {
        fprintf(stderr, "Usage: fixture-encoder GENERATED_F32LE NEW_OGG CHANNELS RATE FRAMES\n");
        return 2;
    }
    int input = -1, output = -1, created = 0, status = 1;
    int info_ready = 0, comment_ready = 0, dsp_ready = 0, block_ready = 0, stream_ready = 0;
    vorbis_info info;
    vorbis_comment comment;
    vorbis_dsp_state dsp;
    vorbis_block block;
    ogg_stream_state stream;
    struct stat original, settled;
    input = open(argv[1], O_RDONLY | O_NOFOLLOW);
    if (input < 0 || fstat(input, &original) != 0 || !S_ISREG(original.st_mode) ||
        original.st_size != (off_t)((uint64_t)frames * channels * 4U)) goto cleanup;
    output = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (output < 0) goto cleanup;
    created = 1;
    vorbis_info_init(&info); info_ready = 1;
    if (vorbis_encode_init_vbr(&info, (long)channels, (long)rate, 0.4f) != 0) goto cleanup;
    if (info.channels != (int)channels || info.rate != (long)rate) goto cleanup;
    vorbis_comment_init(&comment); comment_ready = 1;
    if (vorbis_analysis_init(&dsp, &info) != 0) goto cleanup;
    dsp_ready = 1;
    if (vorbis_block_init(&dsp, &block) != 0) goto cleanup;
    block_ready = 1;
    /* A stable serial is deliberate for these finite generated fixtures only. */
    if (ogg_stream_init(&stream, 0x41555230 + (int)channels) != 0) goto cleanup;
    stream_ready = 1;
    ogg_packet identification, comments, setup;
    if (vorbis_analysis_headerout(&dsp, &comment, &identification, &comments, &setup) != 0) goto cleanup;
    /* Flush identification alone: BOS must contain exactly that one packet. */
    if (!packet_add(&stream, &identification) || !page_drain(output, &stream, 1) || pages != 1 ||
        !packet_add(&stream, &comments) || !packet_add(&stream, &setup) || !page_drain(output, &stream, 1)) goto cleanup;
    unsigned char raw[BLOCK * 2U * 4U];
    uint32_t done = 0;
    while (done < frames) {
        uint32_t count = frames - done;
        if (count > BLOCK) count = BLOCK;
        if (!read_exact(input, raw, (size_t)count * channels * 4U)) goto cleanup;
        float **samples = vorbis_analysis_buffer(&dsp, (int)count);
        if (!samples) goto cleanup;
        for (uint32_t frame = 0; frame < count; frame++) {
            for (uint32_t channel = 0; channel < channels; channel++) {
                const unsigned char *p = raw + (frame * channels + channel) * 4U;
                uint32_t bits = (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
                float sample;
                memcpy(&sample, &bits, sizeof(sample));
                if (!isfinite(sample) || fabsf(sample) > 1.0f || !samples[channel]) goto cleanup;
                samples[channel][frame] = sample;
            }
        }
        if (vorbis_analysis_wrote(&dsp, (int)count) != 0 || !analysis_drain(output, &dsp, &block, &stream)) goto cleanup;
        done += count;
    }
    unsigned char extra;
    if (read(input, &extra, 1) != 0 || fstat(input, &settled) != 0 || original.st_dev != settled.st_dev ||
        original.st_ino != settled.st_ino || original.st_size != settled.st_size ||
        original.st_mtimespec.tv_sec != settled.st_mtimespec.tv_sec || original.st_mtimespec.tv_nsec != settled.st_mtimespec.tv_nsec ||
        original.st_ctimespec.tv_sec != settled.st_ctimespec.tv_sec || original.st_ctimespec.tv_nsec != settled.st_ctimespec.tv_nsec) goto cleanup;
    /* One explicit end marker, then drain genuine library packets/pages. */
    if (vorbis_analysis_wrote(&dsp, 0) != 0 || !analysis_drain(output, &dsp, &block, &stream) ||
        !page_drain(output, &stream, 1) || !eos || final_granule != frames || fsync(output) != 0) goto cleanup;
    status = 0;
cleanup:
    if (stream_ready) ogg_stream_clear(&stream);
    if (block_ready) vorbis_block_clear(&block);
    if (dsp_ready) vorbis_dsp_clear(&dsp);
    if (comment_ready) vorbis_comment_clear(&comment);
    if (info_ready) vorbis_info_clear(&info);
    if (input >= 0 && close(input) != 0) status = 1;
    if (output >= 0 && close(output) != 0) status = 1;
    if (created && status != 0) unlink(argv[2]);
    if (status == 0) fprintf(stdout, "{\"channels\":%u,\"rate\":%u,\"frames\":%u,\"bytes\":%u,\"pages\":%u,\"packets\":%u,\"blocks\":%u,\"quality\":0.4,\"serial\":%u}\n",
        channels, rate, frames, output_bytes, pages, packets, blocks, 0x41555230U + channels);
    return status;
}
