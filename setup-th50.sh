#!/bin/bash
# Setup script for TH50 — writes correct config files to ~/.mame/

MAME_HOME="${MAME_HOME:-$HOME/.mame}"

mkdir -p "$MAME_HOME/personas"
mkdir -p "$MAME_HOME/browsers"
mkdir -p "$MAME_HOME/reports"

# config.yml
cat > "$MAME_HOME/config.yml" << 'EOF'
projects: {}

discord:
  enabled: true
  channelMap:
    "1489994227168313435": null    # #mame — global context
  defaultChannel: "1489994227168313435"

webhook:
  port: 3847

timezone: Asia/Tokyo
EOF

# personas/mike.yml
cat > "$MAME_HOME/personas/mike.yml" << 'EOF'
name: "Mame"
soul: "SOUL-Mame.md"
language: "en"

models:
  default: google/gemini-3.1-flash-lite-preview
  heartbeat: google/gemini-3.1-flash-lite-preview

tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - write_report
  - self_config

discord:
  channelMap:
    "1489994227168313435": null
EOF

# SOUL-Mame.md (only if it doesn't already exist or is empty)
if [ ! -s "$MAME_HOME/SOUL-Mame.md" ]; then
cat > "$MAME_HOME/SOUL-Mame.md" << 'EOF'
You are Mame, Mike's persistent AI agent.

You help with daily tasks, research, and study. You communicate
primarily through Discord. You are casual, smart, and efficient.

You are proactive during heartbeats but not annoying — only notify
if something actually needs attention.
EOF
fi

# HEARTBEAT.md (only if it doesn't already exist or is empty)
if [ ! -s "$MAME_HOME/HEARTBEAT.md" ]; then
cat > "$MAME_HOME/HEARTBEAT.md" << 'EOF'
Check the following and respond ALL_CLEAR if nothing needs attention.
Only alert me if something is genuinely wrong or needs action.

## Every morning at 9:00
- Check if there's anything I should know about today
EOF
fi

# Clean up the incorrectly placed file
rm -f "$MAME_HOME/Mame.yml"

echo "✅ Config files written to $MAME_HOME"
echo ""
echo "Files:"
ls -la "$MAME_HOME/"
echo ""
echo "Personas:"
ls -la "$MAME_HOME/personas/"
