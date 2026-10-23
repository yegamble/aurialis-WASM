#!/usr/bin/env bash
set -euo pipefail
mkdir /output/ffbuild /output/assets /output/relink
cd /output/ffbuild
CONFIGURE=(
  --prefix=/output/install --target-os=none --arch=wasm --enable-cross-compile
  --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --nm=emnm --ar=emar --ranlib=emranlib
  --disable-everything --disable-autodetect --disable-programs --disable-doc
  --disable-debug --disable-stripping --disable-runtime-cpudetect --disable-asm --disable-simd128
  --disable-network --disable-protocols --disable-devices --disable-filters
  --disable-avdevice --disable-avfilter --disable-swscale --disable-iamf
  --disable-pthreads --disable-w32threads --disable-os2threads --disable-symver
  --disable-shared --enable-static --enable-small
  --enable-avformat --enable-avcodec --enable-avutil --enable-swresample
  --enable-demuxer=mp3,flac,ogg,aac,mov
  --enable-decoder=mp3float,flac,vorbis,aac,alac,opus
  --enable-parser=mpegaudio,flac,vorbis,aac,opus
  --extra-cflags=-O3\ -flto\ -fno-fast-math\ -ffp-contract=off
)
printf '%s\n' "${CONFIGURE[@]}" > /output/configure-arguments.txt
emcc --version > /output/emcc-version.txt
emconfigure /ffmpeg/configure "${CONFIGURE[@]}"
# One compiler process until a separate resource ruling permits parallel builds.
emmake make -j1
emmake make install
emcc -O3 -flto -fno-fast-math -ffp-contract=off -D_POSIX_C_SOURCE=200809L \
  -I/output/install/include -I/recipe -c /recipe/decoder.c -o /output/relink/decoder.o
emcc -O3 -flto /output/relink/decoder.o -L/output/install/lib \
  -lavformat -lavcodec -lswresample -lavutil -lm --no-entry \
  --js-library /recipe/decoder-imports.js \
  -sENVIRONMENT=worker -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 -sIMPORTED_MEMORY=1 \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 \
  -sSTACK_SIZE=2097152 -sABORTING_MALLOC=0 -sASSERTIONS=1 \
  -sEXPORTED_FUNCTIONS='["_aurialis_decoder_abi","_aurialis_decoder_open","_aurialis_decoder_next","_aurialis_decoder_output","_aurialis_decoder_rate","_aurialis_decoder_channels","_aurialis_decoder_frames","_aurialis_decoder_close"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -o /output/assets/decoder-core.mjs
cp /output/install/lib/libavformat.a /output/install/lib/libavcodec.a \
   /output/install/lib/libswresample.a /output/install/lib/libavutil.a /output/relink/
cp /ffmpeg/COPYING.LGPLv2.1 /output/relink/
cp /output/ffbuild/config.h /output/ffbuild/config_components.h /output/relink/
python3 /recipe/package-assets.py /output
