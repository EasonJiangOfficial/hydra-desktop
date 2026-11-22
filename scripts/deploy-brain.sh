#!/usr/bin/env bash
# Deploys Hydra's server brain from this Mac to the VPS over SSH. The server never pulls code: no GitHub, no npm.
# Usage: scripts/deploy-brain.sh hydra@<host>      deploy (the user must be hydra)
#        scripts/deploy-brain.sh --stage <dir>     only build what would be shipped, into <dir> (the tests use this)
# The brain is bundled here with esbuild into one file (brain-server.mjs: its code and its dependencies, from this
# Mac's node_modules), so nothing is installed and no install script runs on the server.
# On the server: ~/hydra-brain holds the bundle; ~/.local/bin/hydra-brain runs it; hydra-brain.service is installed
# with sudo -n, only for the unit file and systemctl. hydra needs exactly this sudoers rule (sudo visudo -f
# /etc/sudoers.d/hydra-brain):
#   hydra ALL=(root) NOPASSWD: /usr/bin/install -m 644 -o root -g root /home/hydra/hydra-brain/hydra-brain.service /etc/systemd/system/hydra-brain.service, /usr/bin/systemctl daemon-reload, /usr/bin/systemctl enable hydra-brain.service, /usr/bin/systemctl restart hydra-brain.service
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/showcase/tauri/sidecar"

stage() {
  local out="$1" es="${ESBUILD:-$SRC/node_modules/.bin/esbuild}"
  [ -x "$es" ] || { echo "esbuild not found: install the sidecar dev dependencies in $SRC on this Mac, or set ESBUILD" >&2; exit 1; }
  mkdir -p "$out"
  "$es" "$SRC/brain-server.mjs" --bundle --platform=node --format=esm --target=node22 --outfile="$out/brain-server.mjs" \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
    --log-level=warning
  echo '{"type":"module"}' > "$out/package.json"
  cp "$ROOT/scripts/hydra-brain.service" "$out/hydra-brain.service"
  git -C "$ROOT" describe --always --dirty > "$out/VERSION" 2>/dev/null || echo dev > "$out/VERSION"
}

if [ "${1:-}" = "--stage" ]; then stage "${2:?usage: scripts/deploy-brain.sh --stage <dir>}"; exit 0; fi
TARGET="${1:?usage: scripts/deploy-brain.sh hydra@<host>}"
# The unit runs /home/hydra/hydra-brain as hydra: any other user would install somewhere it never runs.
case "$TARGET" in
  hydra@?*) ;;
  *) echo "Refusing: the target must be hydra@<host> (got '$TARGET'). The service runs as hydra from /home/hydra/hydra-brain." >&2; exit 2 ;;
esac
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
stage "$STAGE"
rsync -az --delete -e ssh "$STAGE/" "$TARGET:hydra-brain/"
# shellcheck disable=SC2087 # expanded on the server, on purpose
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
[ "$(id -un)" = hydra ] || { echo "Refusing: this must run as hydra, not $(id -un)." >&2; exit 2; }
mkdir -p "$HOME/.config/hydra-brain" "$HOME/.local/state/hydra-brain" "$HOME/.claude" "$HOME/.cache" "$HOME/.local/bin"
chmod 700 "$HOME/.config/hydra-brain" "$HOME/.local/state/hydra-brain" "$HOME/.claude"
# Claude Code keeps everything (the login and its .claude.json) in ~/.claude, the one place the service may write:
# CLAUDE_CONFIG_DIR, for the owner's "sudo -iu hydra claude" login shell too. A login made before this keeps its file.
for f in "$HOME/.profile" "$HOME/.bash_profile"; do
  if [ "$f" = "$HOME/.profile" ] || [ -f "$f" ]; then
    grep -qs 'CLAUDE_CONFIG_DIR=' "$f" || printf '\nexport CLAUDE_CONFIG_DIR="$HOME/.claude"\n' >> "$f"
  fi
done
if [ -f "$HOME/.claude.json" ] && [ ! -f "$HOME/.claude/.claude.json" ]; then cp -p "$HOME/.claude.json" "$HOME/.claude/.claude.json"; fi
printf '#!/bin/sh\nexport CLAUDE_CONFIG_DIR="$HOME/.claude"\nexec /usr/bin/node "$HOME/hydra-brain/brain-server.mjs" "$@"\n' > "$HOME/.local/bin/hydra-brain"
chmod 755 "$HOME/.local/bin/hydra-brain"
nosudo() { echo "sudo needs a password here. Add the NOPASSWD rule in scripts/deploy-brain.sh (sudo visudo -f /etc/sudoers.d/hydra-brain), then deploy again." >&2; exit 3; }
sudo -n install -m 644 -o root -g root "$HOME/hydra-brain/hydra-brain.service" /etc/systemd/system/hydra-brain.service || nosudo
sudo -n systemctl daemon-reload || nosudo
sudo -n systemctl enable hydra-brain.service || nosudo
sudo -n systemctl restart hydra-brain.service || nosudo
sleep 3
CLAUDE_CONFIG_DIR="$HOME/.claude" /usr/bin/node "$HOME/hydra-brain/brain-server.mjs" status
systemctl --no-pager --lines=20 status hydra-brain.service || true # printed for the reader; the next line decides
systemctl is-active --quiet hydra-brain.service
REMOTE
