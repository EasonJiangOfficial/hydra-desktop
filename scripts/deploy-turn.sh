#!/usr/bin/env bash
# Sets up coturn on the VPS for Phone View (RV plan O1): a TURN relay for when the phone is on LTE behind a carrier
# NAT. The owner runs it once; it needs root (apt, /etc, systemd, the firewall).
# Usage: scripts/deploy-turn.sh root@<host>          install or update coturn, then print the two Vercel env vars
#        scripts/deploy-turn.sh --render <dir>        only write turnserver.conf into <dir> (the tests use this;
#                                                     TURN_SECRET, TURN_IP and TURN_REALM set its values)
# The secret is made on the server once (/etc/hydra-turn/secret, root only) and kept on later runs. Set the printed
# HYDRA_TURN_URLS and HYDRA_TURN_SECRET in Vercel (Production), then redeploy the web app.
# Check from this Mac after: turnutils_uclient -u <user> -w <password> <ip> (GUESS: the VPS lets UDP 3478 and
# 49160-49200 in; Hostinger's own firewall, if any, must allow them too).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPL="$ROOT/scripts/turnserver.conf.tmpl"

render() { # secret ip realm -> stdout
  sed -e "s|@SECRET@|$1|" -e "s|@EXTERNAL_IP@|$2|" -e "s|@REALM@|$3|" "$TMPL"
}

if [ "${1:-}" = "--render" ]; then
  out="${2:?usage: scripts/deploy-turn.sh --render <dir>}"
  mkdir -p "$out"
  render "${TURN_SECRET:?set TURN_SECRET}" "${TURN_IP:?set TURN_IP}" "${TURN_REALM:-hydra}" > "$out/turnserver.conf"
  exit 0
fi
TARGET="${1:?usage: scripts/deploy-turn.sh root@<host>}"
case "$TARGET" in
  root@?*) ;;
  *) echo "Refusing: the target must be root@<host> (got '$TARGET'): coturn needs apt, /etc and systemd." >&2; exit 2 ;;
esac
scp -q "$TMPL" "$TARGET:/tmp/hydra-turnserver.conf.tmpl"
# shellcheck disable=SC2087 # expanded on the server, on purpose
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Refusing: run as root." >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
command -v turnserver >/dev/null || { apt-get update -qq; apt-get install -y -qq coturn; }
install -d -m 700 /etc/hydra-turn
[ -s /etc/hydra-turn/secret ] || { umask 077; openssl rand -hex 32 > /etc/hydra-turn/secret; }
SECRET="$(cat /etc/hydra-turn/secret)"
IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
[ -n "$IP" ] || { echo "No public IPv4 found." >&2; exit 3; }
umask 077
sed -e "s|@SECRET@|$SECRET|" -e "s|@EXTERNAL_IP@|$IP|" -e "s|@REALM@|hydra|" /tmp/hydra-turnserver.conf.tmpl > /etc/turnserver.conf
rm -f /tmp/hydra-turnserver.conf.tmpl
chown root:turnserver /etc/turnserver.conf 2>/dev/null && chmod 640 /etc/turnserver.conf || chmod 644 /etc/turnserver.conf
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 49160:49200/udp >/dev/null
fi
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn
sleep 2
systemctl is-active --quiet coturn || { systemctl --no-pager --lines=30 status coturn; exit 4; }
echo
echo "coturn is running. Set these in Vercel (Production), then redeploy the web app:"
echo "HYDRA_TURN_URLS=turn:$IP:3478?transport=udp,turn:$IP:3478?transport=tcp"
echo "HYDRA_TURN_SECRET=$SECRET"
REMOTE
