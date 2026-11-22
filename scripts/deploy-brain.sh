#!/usr/bin/env bash
# Deploys Hydra's server brain from this Mac to the VPS over SSH. The server never pulls from GitHub.
# Usage: scripts/deploy-brain.sh hydra@<host>
# Copies only the files the brain needs to ~/hydra-brain, runs npm ci --omit=dev there, installs
# hydra-brain.service (sudo only for the unit file and systemctl), links ~/.local/bin/hydra-brain, prints status.
set -euo pipefail
TARGET="${1:?usage: scripts/deploy-brain.sh hydra@<host>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/showcase/tauri/sidecar"
# The brain and everything it imports (test/brainserver.test.mjs checks this list against the imports).
FILES=(brain-server.mjs relay.mjs relayschema.mjs hydramcp.mjs claudecode.mjs agentstream.mjs safety.mjs package.json package-lock.json)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
for f in "${FILES[@]}"; do cp "$SRC/$f" "$STAGE/$f"; done
cp "$ROOT/scripts/hydra-brain.service" "$STAGE/hydra-brain.service"
git -C "$ROOT" describe --always --dirty > "$STAGE/VERSION" 2>/dev/null || echo dev > "$STAGE/VERSION"
# node_modules on the server is npm's, never synced or deleted from here.
rsync -az --delete --exclude node_modules -e ssh "$STAGE/" "$TARGET:hydra-brain/"
# shellcheck disable=SC2087 # expanded on the server, on purpose
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
npm ci --omit=dev --no-audit --no-fund --prefix "$HOME/hydra-brain"
mkdir -p "$HOME/.config/hydra-brain" "$HOME/.local/state/hydra-brain" "$HOME/.claude" "$HOME/.cache" "$HOME/.local/bin"
chmod 700 "$HOME/.config/hydra-brain" "$HOME/.local/state/hydra-brain"
printf '#!/bin/sh\nexec /usr/bin/node "$HOME/hydra-brain/brain-server.mjs" "$@"\n' > "$HOME/.local/bin/hydra-brain"
chmod 755 "$HOME/.local/bin/hydra-brain"
sudo install -m 644 -o root -g root "$HOME/hydra-brain/hydra-brain.service" /etc/systemd/system/hydra-brain.service
sudo systemctl daemon-reload
sudo systemctl enable hydra-brain.service
sudo systemctl restart hydra-brain.service
sleep 3
/usr/bin/node "$HOME/hydra-brain/brain-server.mjs" status
systemctl --no-pager --lines=20 status hydra-brain.service || true # printed for the reader; the next line decides
systemctl is-active --quiet hydra-brain.service
REMOTE
