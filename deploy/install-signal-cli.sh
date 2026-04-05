#!/bin/bash
# Install signal-cli and register a Signal number for Mame
#
# Usage: bash deploy/install-signal-cli.sh
# Requires: Java 17+ (auto-installed if missing)

set -euo pipefail

SIGNAL_CLI_VERSION="0.13.12"

echo "🫘 Mame — Signal Setup"
echo "======================"
echo ""

# --- Java ---
echo "[1/4] Checking Java..."
if ! command -v java &>/dev/null; then
    echo "  Installing Java 17..."
    apt-get update -qq && apt-get install -y -qq openjdk-17-jre-headless
else
    echo "  Java found: $(java -version 2>&1 | head -1)"
fi

# --- signal-cli ---
echo "[2/4] Installing signal-cli v${SIGNAL_CLI_VERSION}..."
if ! command -v signal-cli &>/dev/null; then
    DOWNLOAD_URL="https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz"
    curl -fsSL "$DOWNLOAD_URL" | tar xz -C /opt/
    ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli
    echo "  Installed to /usr/local/bin/signal-cli"
else
    echo "  signal-cli already installed: $(signal-cli --version 2>&1 || echo 'unknown version')"
fi

# --- Register ---
echo "[3/4] Register Signal number"
echo ""
echo "  You need a phone number for this agent."
echo "  Options:"
echo "    - Google Voice (free, US number)"
echo "    - Twilio (~\$1/mo, any country)"
echo "    - Prepaid SIM"
echo ""
read -p "  Enter phone number (with country code, e.g. +1234567890): " PHONE_NUMBER

echo ""
echo "  Registering ${PHONE_NUMBER} with Signal..."
echo "  Signal will send a verification code via SMS."
echo ""

signal-cli -u "$PHONE_NUMBER" register

echo ""
read -p "  Enter the verification code you received: " VERIFY_CODE

signal-cli -u "$PHONE_NUMBER" verify "$VERIFY_CODE"
echo "  ✅ Number registered!"

# --- Profile ---
echo "[4/4] Set agent profile"
read -p "  Agent name (e.g. 'Siri-chan', 'Mame'): " AGENT_NAME

signal-cli -u "$PHONE_NUMBER" updateProfile --given-name "$AGENT_NAME"

echo ""
echo "============================================"
echo "✅ Signal setup complete!"
echo ""
echo "  Number: $PHONE_NUMBER"
echo "  Name:   $AGENT_NAME"
echo ""
echo "Add this to your config.yml:"
echo ""
echo "  signal:"
echo "    enabled: true"
echo "    number: \"$PHONE_NUMBER\""
echo "    userMap:"
echo "      \"+RECIPIENT_NUMBER\": null"
echo ""
echo "Add this to your persona .yml:"
echo ""
echo "  signal:"
echo "    userNumbers:"
echo "      - \"+RECIPIENT_NUMBER\""
echo ""
echo "Then restart Mame: pm2 restart all"
echo "============================================"
