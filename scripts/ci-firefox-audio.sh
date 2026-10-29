#!/usr/bin/env bash
# cspell:words pulseaudio pactl
# Own an isolated PulseAudio server and null output on ephemeral Linux CI only.
set -euo pipefail
if [ "${CI:-}" != true ] || [ "$(uname -s)" != Linux ]; then
  echo 'Firefox CI audio provisioning requires CI=true on Linux.' >&2
  exit 1
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
export PULSE_RUNTIME_PATH="$RUNNER_TEMP/aurialis-firefox-pulse"
export PULSE_SERVER="unix:$PULSE_RUNTIME_PATH/native"
case "${1:-}" in
  start)
    : "${GITHUB_ENV:?GITHUB_ENV is required}"
    mkdir -p artifacts/browser-engines "$PULSE_RUNTIME_PATH"
    chmod 700 "$PULSE_RUNTIME_PATH"
    env -u PULSE_SERVER pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target="file:$PWD/artifacts/browser-engines/pulseaudio.log"
    pactl load-module module-null-sink sink_name=aurialis_ci rate=48000 channels=2 > artifacts/browser-engines/pulse-module.txt
    pactl set-default-sink aurialis_ci
    pactl set-sink-mute aurialis_ci 0
    pactl info > artifacts/browser-engines/pulse-info.txt
    pactl list short sinks > artifacts/browser-engines/pulse-sinks.txt
    printf 'PULSE_RUNTIME_PATH=%s\nPULSE_SERVER=%s\n' "$PULSE_RUNTIME_PATH" "$PULSE_SERVER" >> "$GITHUB_ENV"
    ;;
  stop)
    if [ -f "$PULSE_RUNTIME_PATH/pid" ]; then pulseaudio --kill; fi
    ;;
  *) echo 'Choose start or stop.' >&2; exit 1 ;;
esac
