#!/bin/bash
# Setup script — writes baseline config files to ~/.mame/

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
    "YOUR_CHANNEL_ID_HERE": null    # global context
  defaultChannel: "YOUR_CHANNEL_ID_HERE"

webhook:
  port: 3847

timezone: UTC
EOF

# personas/default.yml
cat > "$MAME_HOME/personas/default.yml" << 'EOF'
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
    "YOUR_CHANNEL_ID_HERE": null
EOF

# SOUL-Mame.md (only if it doesn't already exist or is empty)
if [ ! -s "$MAME_HOME/SOUL-Mame.md" ]; then
cat > "$MAME_HOME/SOUL-Mame.md" << 'EOF'
You are Mame, a persistent AI agent.

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
Only alert if something is genuinely wrong or needs action.

## Every morning at 9:00
- Check if there's anything worth knowing about today
EOF
fi

echo "✅ Config files written to $MAME_HOME"
echo ""
echo "Next steps:"
echo "  1. Edit $MAME_HOME/config.yml and replace YOUR_CHANNEL_ID_HERE with a real Discord channel ID"
echo "  2. Edit $MAME_HOME/personas/default.yml the same way"
echo "  3. Add your API keys with: mame secrets set global OPENROUTER_API_KEY  (or GEMINI_API_KEY, etc.)"
echo ""
echo "Files:"
ls -la "$MAME_HOME/"
echo ""
echo "Personas:"
ls -la "$MAME_HOME/personas/"
