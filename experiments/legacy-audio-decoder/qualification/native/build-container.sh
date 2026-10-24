#!/usr/bin/env bash
set -euo pipefail
# Native diagnostic build only. No Emscripten decoder or fixture encode runs.
command -v cc
cc --version > /output/cc-version.txt
sha256sum "$(readlink -f "$(command -v cc)")" > /output/cc-sha256.txt
mkdir /output/ffbuild
cd /output/ffbuild
CONFIGURE=(
  --prefix=/output/install --target-os=linux --arch=x86_64 --cc=cc --cxx=c++
  --disable-everything --disable-autodetect --disable-programs --disable-doc
  --disable-debug --disable-stripping --disable-runtime-cpudetect --disable-asm
  --disable-network --disable-protocols --disable-devices --disable-filters
  --disable-avdevice --disable-avfilter --disable-swscale --disable-iamf
  --disable-pthreads --disable-w32threads --disable-os2threads --disable-symver
  --disable-shared --enable-static --enable-small
  --enable-avformat --enable-avcodec --enable-avutil --enable-swresample
  --enable-demuxer=mp3,flac,ogg,aac,mov
  --enable-decoder=mp3float,flac,vorbis,aac,alac,opus
  --enable-parser=mpegaudio,flac,vorbis,aac,opus
  --extra-cflags=-O2\ -fno-fast-math\ -ffp-contract=off
)
printf '%s\n' "${CONFIGURE[@]}" > /output/configure-arguments.txt
/ffmpeg/configure "${CONFIGURE[@]}"
make -j1
make install
python3 /recipe/check-profile.py
cc -std=c17 -O2 -fno-fast-math -ffp-contract=off -D_POSIX_C_SOURCE=200809L \
  -Wall -Wextra -Werror -I/output/install/include /recipe/oracle.c \
  -L/output/install/lib -lavformat -lavcodec -lswresample -lavutil -lm \
  -o /output/native-oracle
# Metadata only: no compressed file is opened at this stage.
/output/native-oracle --version > /output/native-oracle-version.txt
sha256sum /output/native-oracle /recipe/oracle.c /output/install/lib/*.a \
  /output/ffbuild/config.h /output/ffbuild/config_components.h > /output/native-artifact-sha256.txt
