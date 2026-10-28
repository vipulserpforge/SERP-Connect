#!/usr/bin/env bash
# One-time preparation of a NEW Ubuntu 22.04 / 24.04 VPS for the MCP server. Run as root:
#   bash setup-server.sh
# It installs Node 24, pnpm, PM2, Nginx and the firewall, creates the app user "serp", and sets up the Nginx site.
# It does NOT download the project and does NOT get the HTTPS certificate (docs/mcp-web.md does those, step by step).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (log in as root, or put 'sudo' in front)." >&2
  exit 1
fi

APP_USER="${APP_USER:-serp}"
DOMAIN="${DOMAIN:-mcp.serpforge.io}"
SSH_PORT="${SSH_PORT:-22}"
NGINX_TEMPLATE="$(dirname "${BASH_SOURCE[0]}")/nginx-mcp.conf.example"

echo "==> 1/6 System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg nginx ufw certbot python3-certbot-nginx

echo "==> 2/6 Node.js 24"
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs

echo "==> 3/6 pnpm and PM2"
npm install -g pnpm@12.14.0 pm2

echo "==> 4/6 App user '${APP_USER}'"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${APP_USER}"
fi

echo "==> 5/6 Nginx site for ${DOMAIN}"
if [ ! -f "${NGINX_TEMPLATE}" ]; then
  echo "Cannot find ${NGINX_TEMPLATE}. Run this script from the downloaded project (deploy/vps)." >&2
  exit 1
fi
sed "s/mcp\.serpforge\.io/${DOMAIN}/g" "${NGINX_TEMPLATE}" > "/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> 6/6 Firewall (SSH port ${SSH_PORT}, web ports 80 and 443 only) and PM2 auto-start"
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" >/dev/null

echo
echo "Server is ready. Node $(node -v), pnpm $(pnpm -v), PM2 $(pm2 -v)."
echo "Next: follow docs/mcp-web.md (Part 5, step 5.4)."
