# Mame まめ Documentation

**A minimal persistent AI agent that lives on your machine, talks to you on Discord or LINE, and gets smarter over time.**

---

## Quick Start

### Requirements

- Node.js 22+
- A Discord server (for developer use) and/or a LINE account (for personal/Japanese use)
- An API key for either Anthropic (Claude) or OpenRouter (Gemma 4, Claude, etc.)

### Install

```bash
npx mame init
```

This creates `~/.mame/` and starts an onboarding interview. The agent asks you questions and configures itself from your answers. Takes about 5 minutes.

### What the onboarding asks

1. **Language** — English or 日本語. The entire setup runs in your choice.
2. **Your name** — so the agent knows who you are.
3. **Agent name** — what you want to call it.
4. **Personality** — direct and technical? Warm and casual? Your call.
5. **Use case** — coding projects? Shopping? Research? This determines which tools get enabled.
6. **Messaging** — Discord channel IDs for routing. Each channel can map to a project.
7. **Projects** — GitHub repos, local paths, anything the agent should know about.
8. **Accounts** — API keys and credentials, stored encrypted in the vault.
9. **Heartbeat** — what should the agent check on automatically, and how often.

The agent generates all config files and asks you to confirm before saving.

### Start

```bash
npx mame start
```

That's it. The agent is running. Message it on Discord or use the CLI:

```bash
npx mame chat
```

### Verify it's working

```bash
npx mame status
```

Shows all running personas, uptime, and last heartbeat.

---

## User Guide

### Talking to your agent

Message your agent on **Discord**, **LINE**, or the **TUI** (terminal interface).

**Discord:** Each channel can be mapped to a project — messages in `#kantan-finance` automatically load that project's context and memories. Messages in unmapped channels use global context.

**LINE:** Perfect for Japanese-language personal assistants. Each LINE user ID can be mapped to a persona. Your wife messages Siri-chan on LINE in Japanese, you message Mame on Discord in English — same machine, different agents.

**TUI (Terminal):** For setup, troubleshooting, and quick interactions without opening a messaging app.

```bash
npx mame chat                    # Global context
npx mame chat --project jozu     # Project-scoped
```

The TUI also supports slash commands for admin tasks:

```
🫘 mame> /status              — Show agent health
🫘 mame> /memory payment      — Search memories
🫘 mame> /heartbeat           — Force heartbeat check
🫘 mame> /cost                — API cost report
🫘 mame> /secrets             — List stored secret keys
🫘 mame> /doctor              — Full health check
🫘 mame> /help                — List all commands
```

### Memory

Your agent remembers things across conversations. It stores memories in a local SQLite database at `~/.mame/memory.db`.

The agent decides what's worth remembering based on the conversation. You can also explicitly ask it to remember or forget things:

```
"Remember that the Moneris gateway returns null on timeout"
"What do you remember about the payment system?"
"Forget memory #42"
```

Memories are scoped to projects when relevant. A memory stored in the context of `kantan-finance` will surface when you're talking in that project's channel.

Memories are ranked by relevance (text match), recency, and how often they've been accessed. Important things that get referenced frequently stay at the top.

### Browser

Your agent can browse the web with persistent login sessions. Each site gets its own saved profile — login once, stay logged in across restarts.

**Setting up a login:**

```
"Log into my Amazon Japan account"
```

The agent opens a browser, navigates to the login page, and asks you for credentials. Email and password are stored encrypted in the vault. If the site requires 2FA, the agent asks you to provide the code.

After the first login, the session cookies persist. The agent reuses them automatically. If a session expires, it re-authenticates using saved credentials and only bothers you for a fresh 2FA code if needed.

**Browser profiles are stored in:**

```
~/.mame/browsers/
├── amazon-jp/
├── newrelic/
├── rakuten/
└── default/
```

**Browsing without login:**

The agent can also browse any public page without authentication:

```
"Search for dining tables under ¥50,000 on Amazon"
"Check if my site kantan.finance is loading properly"
"Find me ramen restaurants near Kamakura station"
```

### Web research

For research that doesn't require a browser (no login, no interaction), the agent uses web search and page fetching:

```
"Research the latest Next.js 15 features and write me a summary"
"What are people saying about Gemma 4 on Twitter?"
"Find undervalued Japanese stocks with no debt and solid revenue"
```

The agent searches, reads pages, and can compile findings into a report.

### Reports

Ask the agent to write reports and it saves them as markdown files:

```
"Write a weekly progress report for all my projects"
"Research competitor pricing and write a report"
"Summarize my GitHub activity this week"
```

Reports are saved to `~/.mame/reports/` and can also be delivered directly to Discord or email.

### GitHub

The agent can interact with your GitHub repos:

```
"What PRs are open on kantan-finance?"
"Show me the recent commits on jozu"
"Create an issue on mame: heartbeat not firing on schedule"
"Search the codebase for references to Moneris"
```

It reads code, lists PRs, creates issues, and checks notifications. For actual code changes, it dispatches to Claude Code (see below).

### Claude Code (developers only)

For any code changes, the agent dispatches work to Claude Code rather than writing code itself:

```
"Fix the null handling in the payment gateway"
"Add a dark mode toggle to the settings page"
"Run the test suite on jozu and tell me what's failing"
```

The agent formulates the task, loads relevant memories and project context, and hands it to Claude Code running on your machine. Claude Code does the actual file editing, testing, git operations, and PR creation. The agent reports back with results.

This only works if Claude Code is installed on the same machine.

### Email

If you've set up AgentMail, your agent has its own email inbox:

```
"Check my email for anything urgent"
"Send an email to client@example.com with the project update"
"Search my inbox for messages from New Relic"
```

The agent can receive alerts (New Relic, GitHub notifications, etc.) via email and act on them proactively.

### Self-improvement

When you ask the agent to do something it can't do, it can build the capability:

```
"Can you monitor my Vercel deployments?"
"I don't have a Vercel tool yet. Want me to build one?"
"Yeah, go for it"
```

The agent dispatches Claude Code to add a new tool to its own codebase, following existing patterns. It always asks for your approval before modifying itself. After the change, it restarts and the new capability is live.

Over time, your agent accumulates tools tailored to your specific needs. Every self-modification is a git commit, so you can review changes or revert if something breaks.

### Heartbeats

Your agent runs scheduled checks in the background. These are configured in `~/.mame/HEARTBEAT.md` — a plain text file you can edit directly, or ask the agent to update:

```
"Add a check for my Vercel deployments every hour"
"Stop checking GitHub on weekends"
"Change the morning briefing to 8am"
```

The agent only notifies you when something needs attention. Routine checks that find nothing are silently logged.

Heartbeats use a cheaper, faster model to keep costs low. If a check finds something that needs real reasoning, it escalates to the full model automatically.

---

## Settings & Config

All configuration lives in `~/.mame/`. You can edit files directly or ask the agent to make changes.

### Directory structure

```
~/.mame/
├── SOUL-[name].md         # Agent personality per persona
├── HEARTBEAT.md           # Scheduled checks
├── config.yml             # Runtime configuration
├── personas/
│   └── [name].yml         # Per-persona tools + channels
├── .vault/
│   └── [project].enc      # Encrypted secrets per project
├── browsers/
│   └── [site]/            # Persistent browser profiles
├── memory.db              # All memories (SQLite)
└── reports/               # Generated reports
```

### config.yml

The main configuration file.

```yaml
# Projects
projects:
  kantan-finance:
    path: ~/Projects/kantan-finance       # Local path
    github: yourusername/kantan-finance    # GitHub repo
  jozu:
    path: ~/Projects/jozu
    github: yourusername/jozu

# Discord (developer workflow)
discord:
  enabled: true
  channelMap:
    "123456789": kantan-finance    # Channel ID → project
    "123456790": jozu
    "123456791": null              # No project (global context)
  defaultChannel: "123456791"      # Where heartbeat alerts go

# LINE (personal assistant / Japanese)
line:
  enabled: true
  userMap:
    "U1234567890abcdef": null      # Yuki — global context
  defaultUserId: "U1234567890abcdef"

# Webhooks
webhook:
  port: 3847                       # Port for inbound webhooks

# AgentMail
agentmail:
  pollInterval: 60                 # Seconds between inbox checks
```

### Persona files

Each persona defines which model and tools that user gets.

```yaml
# ~/.mame/personas/mike.yml

name: "Mame"
soul: "SOUL-mike.md"
language: "en"

models:
  default: openrouter/anthropic/claude-sonnet-4-6
  complex: openrouter/anthropic/claude-opus-4-6
  heartbeat: openrouter/google/gemma-4-31b-it

tools:
  - browser
  - web_search
  - web_fetch
  - github
  - email
  - claude_code
  - memory
  - report
  - self_modify

discord:
  channelMap:
    "123456789": kantan-finance
    "123456790": jozu
    "123456791": null
```

```yaml
# ~/.mame/personas/yuki.yml

name: "Siri-chan"
soul: "SOUL-yuki.md"
language: "ja"

models:
  default: openrouter/google/gemma-4-31b-it
  heartbeat: openrouter/google/gemma-4-26b-a4b-it

tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - report
  # No github, claude_code, email, or self_modify

line:
  userIds:
    - "U1234567890abcdef"
```

### SOUL.md

The agent's personality. Written in the user's language. Edit directly or ask the agent to adjust.

```markdown
# Example: ~/.mame/SOUL-mike.md

You are Mame, Mike's persistent AI agent running on his TH50 server.
You help manage his software projects, monitor his infrastructure,
research topics, and coordinate coding work via Claude Code.

You communicate primarily through Discord. You are direct, technical,
and don't waste words.

You are proactive during heartbeats but not annoying — only notify
if something actually needs attention.
```

```markdown
# Example: ~/.mame/SOUL-yuki.md

あなたはSiri-chan、ゆきさんの個人アシスタントです。

お手伝いすること：
- オンラインショッピング（Amazon、楽天など）
- カレンダーとスケジュール管理
- レストランやお出かけ先の検索
- レシピ検索
- 好みや大事な日付を覚える

フレンドリーで優しい性格で、日本語で会話します。
購入する前に必ず確認を取ります。
```

### HEARTBEAT.md

What the agent checks automatically. Plain text, human-editable.

```markdown
# ~/.mame/HEARTBEAT.md

Check the following. Reply ALL_CLEAR if nothing needs attention.
Only alert me if something is genuinely wrong or needs action.

## Every 30 minutes
- Check agentmail inbox for new messages
- Check GitHub notifications across all repos

## Every morning at 9:00 JST
- Summarize overnight emails
- List today's tasks across all projects
- Check deployment status of production sites
- Send briefing to Discord

## Every Friday at 17:00 JST
- Compile weekly progress report
- Summarize completed tasks and open blockers
- Send to Discord
```

### Secrets vault

Credentials are stored encrypted, scoped per project.

```bash
# Add secrets via CLI
npx mame secrets set global DISCORD_BOT_TOKEN
npx mame secrets set global ANTHROPIC_API_KEY
npx mame secrets set global LINE_CHANNEL_ACCESS_TOKEN
npx mame secrets set global LINE_CHANNEL_SECRET
npx mame secrets set kantan-finance VERCEL_TOKEN

# Or tell the agent in Discord
"Store this API key for kantan-finance: sk_xxxxx"

# List secret keys (values never shown)
npx mame secrets list
npx mame secrets list kantan-finance

# Remove a secret
npx mame secrets delete kantan-finance VERCEL_TOKEN
```

Secrets are encrypted with AES-256-GCM. The master key is stored in your OS keychain or set via the `MAME_MASTER_KEY` environment variable.

### Model configuration

Mame supports any model available through OpenRouter or the Anthropic API directly.

```yaml
# OpenRouter models (recommended — one API key, all models)
models:
  default: openrouter/anthropic/claude-sonnet-4-6
  heartbeat: openrouter/google/gemma-4-31b-it

# Direct Anthropic API
models:
  default: claude-sonnet-4-6-20250514

# Local models via Ollama
models:
  default: ollama/gemma4:31b
```

**Cost guidance:**

| Model | Input/M tokens | Best for |
|---|---|---|
| Gemma 4 31B (OpenRouter) | $0.14 | Non-coding personas, heartbeats, simple tasks |
| Gemma 4 26B MoE (OpenRouter) | $0.13 | Ultra-cheap heartbeats |
| Claude Haiku 4.5 | $1.00 | Fast heartbeat checks |
| Claude Sonnet 4.6 | $3.00 | Default for developer workflows |
| Claude Opus 4.6 | $15.00 | Complex reasoning, architecture decisions |

The agent automatically uses the `heartbeat` model for scheduled checks and the `default` model for conversations. Complex tasks can be escalated to `complex` if configured.

### Adding a new persona

```bash
npx mame init --persona
```

Runs the onboarding interview for a new user. Creates a new persona file, SOUL.md, and adds to the pm2 ecosystem. The new persona runs as a separate process with its own Discord channels, memory scope, and tool permissions.

---

## Troubleshooting

### Agent isn't responding on Discord

**Check if it's running:**
```bash
npx mame status
```

If it shows as stopped:
```bash
npx mame start
```

**Check logs for errors:**
```bash
npx mame logs
```

**Common causes:**
- Discord bot token expired or invalid → `npx mame secrets set global DISCORD_BOT_TOKEN`
- Bot not added to your Discord server → re-invite with the OAuth URL from Discord Developer Portal
- Bot doesn't have Message Content intent enabled → enable in Discord Developer Portal under Bot settings

### Agent isn't responding on LINE

**Check logs:**
```bash
npx mame logs
```

**Common causes:**
- LINE channel access token or secret incorrect → `npx mame secrets set global LINE_CHANNEL_ACCESS_TOKEN`
- Webhook URL not configured in LINE Developer Console → set to `https://your-domain:3847/line/webhook`
- LINE requires HTTPS for webhooks → use a reverse proxy (Caddy auto-provisions SSL) or Tailscale Funnel
- User ID not mapped in config → add their LINE user ID to `config.yml` under `line.userMap`

### Heartbeats not firing

**Check the schedule:**
```bash
npx mame heartbeat status
```

**Force a heartbeat manually:**
```bash
npx mame heartbeat run
```

**Common causes:**
- HEARTBEAT.md has a syntax error → check the file format, keep it simple
- Timezone misconfigured → heartbeats use `Asia/Tokyo` by default, change in config.yml
- Process crashed and pm2 didn't restart → `npx mame start` to restart

### Browser login expired

Sessions expire naturally. The agent should detect the login page and re-authenticate automatically using saved credentials.

If it's not working:

**Reset the browser profile:**
```bash
rm -rf ~/.mame/browsers/amazon-jp
```

Then ask the agent to log in again: "Log into my Amazon Japan account"

**If 2FA keeps failing:**

Some sites aggressively rotate 2FA. The agent will ask you for the code each time. If this happens too often, check if the site offers app-based authentication (TOTP) which tends to be more stable with automated sessions.

### Memory not finding relevant results

FTS5 text search works on keyword matching. If your query doesn't share words with the stored memory, it won't match.

**Check what's stored:**
```bash
npx mame memory search "payment"
npx mame memory list --project kantan-finance
npx mame memory stats
```

**Tips for better recall:**
- Store memories with specific keywords: "Moneris payment gateway returns null on timeout" is better than "there's a bug"
- The agent extracts skills automatically after complex tasks — these tend to be well-keyworded
- If important context isn't being recalled, explicitly ask: "Remember that kantan-finance uses Moneris for payment processing"

### Self-modification failed

If the agent tried to build a new tool and something broke:

**Check what changed:**
```bash
cd ~/Projects/mame
git log --oneline -5
git diff HEAD~1
```

**Revert the change:**
```bash
git revert HEAD
npx mame start
```

The agent's self-modify tool is restricted — it cannot change core files (`agent.ts`, `gateway.ts`, `memory.ts`). It can only add or modify files in `src/tools/`. If something in the core broke, it wasn't the self-modify tool — check logs for the real cause.

### API costs higher than expected

**Check spending:**
```bash
npx mame cost report
npx mame cost report --last 7d
npx mame cost report --by-tool
```

**Common causes of high costs:**
- Heartbeat interval too frequent → increase interval in HEARTBEAT.md
- Using Opus/Sonnet for heartbeats → switch heartbeat model to Gemma 4 or Haiku
- Long conversations with lots of context → the agent loads memories and project context on every turn
- Browser tool generating many screenshots → each screenshot sent to a vision model costs more

**Cost optimization:**
- Use Gemma 4 ($0.14/M) for non-coding personas
- Use Haiku ($1/M) or Gemma 4 for heartbeats
- Reserve Sonnet/Opus for developer workflows that need strong reasoning
- Keep SOUL.md and project context concise — shorter system prompts = fewer tokens per turn

### Webhook not receiving alerts

**Check the webhook server is running:**
```bash
curl http://localhost:3847/health
```

**Test with a manual webhook:**
```bash
curl -X POST http://localhost:3847/webhook/test \
  -H "Content-Type: application/json" \
  -d '{"message": "test alert"}'
```

**Common causes:**
- Port 3847 blocked by firewall → open the port or change in config.yml
- Server not running → check `npx mame status`
- External service can't reach your machine → you need a public URL. Use a reverse proxy (Caddy/nginx), Tailscale Funnel, or ngrok to expose the webhook endpoint.

### Multiple personas conflicting

Each persona runs as a separate pm2 process. They share the same `~/.mame/` directory but have separate memory scopes and Discord channels.

**If messages are going to the wrong persona:**
- Check channel mappings in each persona's yml file — no two personas should share a Discord channel
- Run `npx mame status` to see which persona owns which channels

**If memory is leaking between personas:**
- Memories are scoped by project. Global memories (no project) are shared. Project-scoped memories stay within their project context.
- Each persona has its own conversation history

### Full health check

```bash
npx mame doctor
```

This checks:
- All pm2 processes running
- Discord bot connected
- Webhook server responding
- Memory database accessible
- Vault decryptable
- Browser profiles valid
- API keys working (makes a test call)
- Disk space for memory.db and browser profiles

---

## CLI Reference

```bash
npx mame init                      # First-time setup with onboarding interview
npx mame init --persona            # Add a new persona
npx mame start                     # Start all personas
npx mame stop                      # Stop all personas
npx mame restart                   # Restart all personas
npx mame status                    # Show health of all personas

npx mame chat                      # Interactive CLI (global context)
npx mame chat --project [name]     # Interactive CLI (project context)
npx mame chat --persona [name]     # Chat as a specific persona

npx mame logs                      # Tail all logs
npx mame logs [persona]            # Tail specific persona logs

npx mame heartbeat status          # Show heartbeat schedule
npx mame heartbeat run             # Force immediate heartbeat
npx mame heartbeat run --persona   # Heartbeat for specific persona

npx mame memory search [query]     # Search memories
npx mame memory list               # List recent memories
npx mame memory list --project     # List project-scoped memories
npx mame memory stats              # Memory count, size, categories
npx mame memory export             # Export all memories as JSON

npx mame secrets list              # List all secret keys
npx mame secrets list [project]    # List project secret keys
npx mame secrets set [proj] [key]  # Set a secret (prompts for value)
npx mame secrets delete [proj] [key]

npx mame cost report               # API cost breakdown
npx mame cost report --last [Nd]   # Last N days
npx mame cost report --by-tool     # Costs per tool

npx mame doctor                    # Full health check
```
