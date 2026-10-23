#!/usr/bin/env bash
set -euo pipefail
python3 /recipe/copy-relink-inputs.py
export EM_CACHE=/output/emcache
mkdir /output/assets
emcc --version > /output/emcc-version.txt
cp /recipe/build-container.sh /recipe/relink-container.sh /recipe/copy-relink-inputs.py /output/relink/
emcc -O3 -flto /output/relink/decoder.o -L/output/relink \
  -lavformat -lavcodec -lswresample -lavutil -lm --no-entry \
  --js-library /recipe/decoder-imports.js \
  -sENVIRONMENT=worker -sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 -sIMPORTED_MEMORY=1 \
  -sINCOMING_MODULE_JS_API='["wasmBinary","wasmMemory","print","printErr"]' \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 \
  -sSTACK_SIZE=2097152 -sABORTING_MALLOC=0 -sASSERTIONS=1 \
  -sEXPORTED_FUNCTIONS='["_aurialis_decoder_abi","_aurialis_decoder_open","_aurialis_decoder_next","_aurialis_decoder_output","_aurialis_decoder_rate","_aurialis_decoder_channels","_aurialis_decoder_frames","_aurialis_decoder_close"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -o /output/assets/decoder-core.mjs
emnm -g --defined-only /output/relink/libavformat.a /output/relink/libavcodec.a \
  /output/relink/libswresample.a /output/relink/libavutil.a > /output/static-symbols.txt
# Separate synthetic wrapper test module; never copied into runtime assets.
mkdir /output/unit
emcc -O3 -flto -fno-fast-math -ffp-contract=off -D_POSIX_C_SOURCE=200809L \
  -I/output/install/include -I/recipe /recipe/fixtures/decoder-cases.c -L/output/relink \
  -lavformat -lavcodec -lswresample -lavutil -lm --no-entry \
  -Wl,--wrap=avformat_open_input -Wl,--wrap=avcodec_open2 -Wl,--wrap=av_read_frame \
  -Wl,--wrap=avcodec_receive_frame -Wl,--wrap=avcodec_send_packet \
  -sENVIRONMENT=node -sMODULARIZE=1 -sEXPORT_ES6=1 -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 \
  -sINCOMING_MODULE_JS_API='["wasmBinary","wasmMemory","print","printErr"]' \
  -sIMPORTED_MEMORY=1 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 \
  -sSTACK_SIZE=2097152 -sABORTING_MALLOC=0 -sASSERTIONS=1 \
  -sEXPORTED_FUNCTIONS='["_aurialis_test_count","_aurialis_test_case"]' \
  -o /output/unit/decoder-cases.mjs
python3 /recipe/package-assets.py /output
