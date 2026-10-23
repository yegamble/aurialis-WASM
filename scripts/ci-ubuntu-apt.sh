#!/usr/bin/env bash
set -euo pipefail

# CI-only VM setup; never called by the application or its audio/request paths.
if [[ "$(uname -s)" != Linux || ! -d /etc/apt/apt.conf.d ]]; then
  echo "This helper requires an Ubuntu/Debian CI runner." >&2
  exit 1
fi

# Playwright launches apt-get through its own privileged child. A root-owned
# apt configuration applies these bounds without relying on sudo environment.
sudo tee /etc/apt/apt.conf.d/99aurialis-ci-network >/dev/null <<'APT'
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Languages "none";
APT

# Retain Ubuntu package signature checks; change only the known hosted-runner
# Azure archive endpoint, including both mirror-list and direct-source layouts.
for source_file in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
  if [[ -f "$source_file" ]]; then
    sudo sed -i -E 's#https?://azure\.archive\.ubuntu\.com/ubuntu([[:space:]/]|$)#https://archive.ubuntu.com/ubuntu\1#g' "$source_file"
  fi
done
