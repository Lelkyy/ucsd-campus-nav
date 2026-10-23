#!/usr/bin/env bash
# Sets up the MTS recorder (scripts/record-mts.ts) as an always-on service on a fresh Debian or Ubuntu
# server, such as a Google Cloud e2-micro. Run it again to update to the latest code on the branch.
#
#   curl -fsSL https://raw.githubusercontent.com/Lelkyy/ucsd-campus-nav/barebones/prediction/scripts/server/setup-recorder.sh -o setup.sh
#   bash setup.sh
#
# Asks for the MTS API key once and keeps it in /etc/mts-recorder.env, readable only by root.
# Recordings go to /var/lib/mts-recorder, one gzipped file per hour.
set -euo pipefail

REPO=https://github.com/Lelkyy/ucsd-campus-nav.git
BRANCH=barebones/prediction
APP=/opt/ucsd-campus-nav
DATA=/var/lib/mts-recorder
KEY_FILE=/etc/mts-recorder.env

echo "== Swap: 1 GB of memory is tight for installing packages"
# /proc/swaps lists active swap without needing swapon, which isn't on a normal user's PATH.
if grep -q '^/swapfile ' /proc/swaps; then
  echo "Already on."
elif sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile; then
  grep -q '^/swapfile ' /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
else
  echo "Couldn't add swap here; carrying on without it."
  sudo rm -f /swapfile || true
fi

echo "== Node.js 20 or newer, and git"
sudo apt-get update -qq
sudo apt-get install -y git
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
# Debian 13 and Ubuntu 24.04 ship Node 20 or newer; older releases get it from NodeSource.
if [ "$(node_major)" -lt 20 ]; then
  apt_major=$(apt-cache policy nodejs | sed -n 's/^ *Candidate: \([0-9]*\).*/\1/p')
  if [ "${apt_major:-0}" -ge 20 ]; then
    sudo apt-get install -y nodejs npm
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi
echo "Node $(node --version)"

echo "== The code, on $BRANCH"
id mts >/dev/null 2>&1 || sudo useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin mts
if [ -d "$APP/.git" ]; then
  sudo -u mts git -C "$APP" fetch --quiet origin
  sudo -u mts git -C "$APP" checkout --quiet "$BRANCH"
  sudo -u mts git -C "$APP" reset --quiet --hard "origin/$BRANCH"
else
  sudo mkdir -p "$APP"
  sudo chown mts:mts "$APP"
  sudo -u mts git clone --quiet --branch "$BRANCH" "$REPO" "$APP"
fi
(cd "$APP" && sudo -u mts npm ci --no-audit --no-fund --loglevel=error)

echo "== MTS API key"
if ! sudo test -s "$KEY_FILE"; then
  read -rsp "Paste your MTS API key (it won't show): " KEY
  echo
  printf 'MTS_KEY=%s\n' "$KEY" | sudo tee "$KEY_FILE" >/dev/null
  sudo chmod 600 "$KEY_FILE"
fi

echo "== Service"
sudo cp "$APP/scripts/server/mts-recorder.service" /etc/systemd/system/mts-recorder.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet mts-recorder
sudo systemctl restart mts-recorder
sleep 20
sudo journalctl -u mts-recorder --no-pager -n 6
echo
echo "Recording. Watch it with:  sudo journalctl -u mts-recorder -f"
