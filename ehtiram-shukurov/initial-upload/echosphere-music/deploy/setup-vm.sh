#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 VM (Oracle Always Free or any other).
# Run as your normal sudo-capable user from inside the cloned repository:
#   bash deploy/setup-vm.sh your-name.duckdns.org
set -euo pipefail
HOSTNAME_ARG="${1:-}"
[ -n "$HOSTNAME_ARG" ] || { echo "Usage: bash deploy/setup-vm.sh <public-hostname>"; exit 1; }
cd "$(dirname "$0")"

echo "== Installing Docker and the firewall persistence tool"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 iptables-persistent
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

echo "== Opening web ports 80 and 443 in the VM's own firewall (SSH stays as it was)"
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
sudo netfilter-persistent save

if [ ! -f .env ]; then
  KEY="$(openssl rand -hex 24)"
  cp .env.example .env
  sed -i "s|^ECHOSPHERE_HOSTNAME=.*|ECHOSPHERE_HOSTNAME=${HOSTNAME_ARG}|; s|^ECHOSPHERE_API_KEY=.*|ECHOSPHERE_API_KEY=${KEY}|" .env
  chmod 600 .env
  echo
  echo "== Your access key (shown once here; it is also stored in deploy/.env on this VM):"
  echo "   ${KEY}"
  echo "   Save it in a password manager, then share it with teammates privately."
else
  echo "== deploy/.env already exists; leaving it unchanged"
fi

echo
echo "== Next: start it (a new login may be needed first so Docker permissions apply):"
echo "   sg docker -c 'docker compose up -d --build'"
echo "   Then open https://${HOSTNAME_ARG} once DNS points at this VM."
