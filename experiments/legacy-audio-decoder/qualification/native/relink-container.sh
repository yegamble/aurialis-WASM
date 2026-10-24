#!/usr/bin/env bash
set -euo pipefail
python3 /recipe/copy-native-inputs.py
cc --version > /output/current-cc-version.txt
sha256sum "$(readlink -f "$(command -v cc)")" > /output/current-cc-sha256.txt
cmp /output/current-cc-sha256.txt /output/cc-sha256.txt
python3 /recipe/check-profile.py
cc -std=c17 -O2 -fno-fast-math -ffp-contract=off -D_POSIX_C_SOURCE=200809L \
  -Wall -Wextra -Werror -I/output/install/include /recipe/oracle.c \
  -L/output/install/lib -lavformat -lavcodec -lswresample -lavutil -lm \
  -o /output/native-oracle
/output/native-oracle --version > /output/native-oracle-version.txt
sha256sum /output/native-oracle /recipe/oracle.c /output/install/lib/*.a \
  /output/ffbuild/config.h /output/ffbuild/config_components.h > /output/native-artifact-sha256.txt
