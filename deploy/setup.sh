#!/bin/bash
# Mame — Fresh Hetzner VPS Setup Script
# Run as root on a fresh Ubuntu 22.04/24.04 VPS
#
# Usage: curl -fsSL https://raw.githubusercontent.com/maikunari/mame/main/deploy/setup.sh | bash

set -euo pipefail

echo "🫘 Mame — VPS Setup"
echo "==================="
echo ""

# --- System updates ---
echo "[1/7] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# --- Docker ---
echo "[2/7] Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "  Docker already installed: $(docker --version)"
fi

# --- Docker Compose (v2 plugin) ---
echo "[3/7] Verifying Docker Compose..."
if ! docker compose version &>/dev/null; then
    apt-get install -y -qq docker-compose-plugin
fi
echo "  $(docker compose version)"

# --- Firewall ---
echo "[4/7] Configuring firewall..."
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Caddy redirect)
ufw allow 443/tcp   # HTTPS (Caddy)
ufw --force enable
echo "  UFW enabled: SSH, HTTP, HTTPS only"

# --- Fail2ban ---
echo "[5/7] Installing fail2ban..."
apt-get install -y -qq fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# --- Clone Mame ---
echo "[6/7] Cloning Mame..."
MAME_DIR="/opt/mame"
if [ -d "$MAME_DIR" ]; then
    echo "  $MAME_DIR already exists, pulling latest..."
    cd "$MAME_DIR" && git pull
else
    git clone https://github.com/maikunari/mame.git "$MAME_DIR"
    cd "$MAME_DIR"
fi

# --- Create .env ---
echo "[7/7] Setting up environment..."
if [ ! -f "$MAME_DIR/.env" ]; then
    cp deploy/.env.example .env

    # Generate master key
    MASTER_KEY=$(openssl rand -hex 32)
    sed -i "s/^MAME_MASTER_KEY=$/MAME_MASTER_KEY=$MASTER_KEY/" .env

    echo ""
    echo "  ⚠️  Master key generated and saved to .env"
    echo "  ⚠️  Back up this key: $MASTER_KEY"
    echo ""
    echo "  Edit .env to add your API keys:"
    echo "    nano $MAME_DIR/.env"
else
    echo "  .env already exists, skipping"
fi

echo ""
echo "============================================"
echo "🫘 Mame VPS setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit your .env file:  nano $MAME_DIR/.env"
echo "     - Add MAME_DOMAIN (your domain pointing to this server)"
echo "     - Add GOOGLE_API_KEY or ANTHROPIC_API_KEY"
echo "     - Add DISCORD_BOT_TOKEN"
echo ""
echo "  2. Run onboarding to create config files:"
echo "     docker compose run --rm mame node dist/cli.js init"
echo ""
echo "  3. Start Mame:"
echo "     docker compose up -d"
echo ""
echo "  4. Check status:"
echo "     docker compose logs -f mame"
echo "     curl https://\$(grep MAME_DOMAIN .env | cut -d= -f2)/health"
echo "============================================"
