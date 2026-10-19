#!/usr/bin/env bash
# Build on Box A and roll out to both boxes (Decisions.txt D-37/D-38).
#   deploy/deploy.sh            # sync, build on A, ship to B, restart both
#   deploy/deploy.sh --setup    # first time: also install Caddy, units and env files (idempotent)
#   SKIP_WEB=1 deploy/deploy.sh # server only (no web build)
# Hosts come from deploy/hosts.env (gitignored; copy deploy/hosts.env.example) or the environment.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=/dev/null
[[ -f "$ROOT/deploy/hosts.env" ]] && source "$ROOT/deploy/hosts.env"
A=${BOX_A:?set BOX_A=user@host in deploy/hosts.env}
B=${BOX_B:?set BOX_B=user@host in deploy/hosts.env}
KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
ssh_() { ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$@"; }
NODE='export PATH=$HOME/.local/node/bin:$PATH'

echo "==> sync source to Box A ($A)"
tar -C "$ROOT" --exclude=node_modules --exclude=dist --exclude=.git --exclude='*.pdf' --exclude='.env' --exclude='.env.local' --exclude='hosts.env' -czf - . \
  | ssh_ "$A" 'mkdir -p ~/odds && tar -xzf - -C ~/odds'

echo "==> build on Box A"
BUILD=${SKIP_WEB:+build:server}
ssh_ "$A" "$NODE && cd ~/odds && npm ci --no-fund --no-audit --loglevel=error && npm run ${BUILD:-build} 2>&1 | tail -4"

echo "==> ship the server build to Box B ($B)"
ssh_ "$A" 'cd ~/odds && tar -czf - dist deploy package.json package-lock.json .npmrc' \
  | ssh_ "$B" "mkdir -p ~/odds && rm -rf ~/odds/dist && tar -xzf - -C ~/odds && $NODE && cd ~/odds && npm ci --omit=dev --no-fund --no-audit --loglevel=error"

if [[ "${1:-}" == "--setup" ]]; then
  echo "==> one-time setup on Box A: Caddy, units, env"
  ssh_ "$A" 'bash -s' <<'SETUP_A'
set -euo pipefail
V=2.11.7
if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$V"; then
  T=$(mktemp -d); cd "$T"
  curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$V/caddy_${V}_linux_amd64.tar.gz"
  curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v$V/caddy_${V}_checksums.txt"
  grep " caddy_${V}_linux_amd64.tar.gz\$" "caddy_${V}_checksums.txt" | sha512sum -c -
  tar -xzf "caddy_${V}_linux_amd64.tar.gz" caddy && sudo install -m 0755 caddy /usr/local/bin/caddy && cd / && rm -rf "$T"
fi
id caddy >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
sudo mkdir -p /var/lib/caddy /etc/caddy /etc/odds && sudo chown caddy:caddy /var/lib/caddy
sudo install -m 0644 ~/odds/deploy/Caddyfile /etc/caddy/Caddyfile
sudo install -m 0644 ~/odds/deploy/odds-board.service ~/odds/deploy/caddy.service /etc/systemd/system/
if ! sudo test -f /etc/odds/board.env; then
  sed -e "s/<openssl rand -hex 32>/$(openssl rand -hex 32)/" -e "s/<box-a-private-ip>/$(hostname -I | awk '{print $1}')/" \
    ~/odds/deploy/board.env.example | sudo tee /etc/odds/board.env >/dev/null
  sudo chmod 600 /etc/odds/board.env
fi
sudo systemctl daemon-reload && sudo systemctl enable odds-board caddy
SETUP_A
  echo "==> one-time setup on Box B: unit, env (token copied from Box A)"
  TOKEN=$(ssh_ "$A" "sudo sed -n 's/^FEED_TOKEN=//p' /etc/odds/board.env")
  LISTEN=$(ssh_ "$A" "sudo sed -n 's/^FEED_LISTEN=//p' /etc/odds/board.env")
  ssh_ "$B" "TOKEN=$TOKEN LISTEN=$LISTEN bash -s" <<'SETUP_B'
set -euo pipefail
sudo mkdir -p /etc/odds
sudo install -m 0644 ~/odds/deploy/odds-feed.service /etc/systemd/system/
sed -e "s/<same token as Box A>/$TOKEN/" -e "s/<box-a-private-ip>:7070/$LISTEN/" ~/odds/deploy/feed.env.example | sudo tee /etc/odds/feed.env >/dev/null
sudo chmod 600 /etc/odds/feed.env
sudo systemctl daemon-reload && sudo systemctl enable odds-feed
SETUP_B
fi

echo "==> restart"
ssh_ "$A" 'sudo systemctl restart odds-board && (systemctl is-enabled caddy >/dev/null 2>&1 && sudo systemctl restart caddy || true); sleep 2; systemctl is-active odds-board caddy || true'
ssh_ "$B" 'sudo systemctl restart odds-feed; sleep 2; systemctl is-active odds-feed || true'
echo "==> done"
