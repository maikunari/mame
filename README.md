# Mame まめ

**v0.1.2** — A minimal persistent AI agent that lives on your machine, talks to you on Discord or LINE, and gets smarter over time.

~2,500 lines of TypeScript. 8 npm dependencies. One SQLite file for memory. Self-improving.

## What it does

Mame is a personal daemon that listens for messages, thinks using Claude (or Gemini Flash Lite for lightweight instances), and dispatches work to the right place.

- **Memory** — SQLite + FTS5. Remembers what matters, forgets what doesn't.
- **Browser** — Persistent login sessions via agent-browser. Login once, stay logged in.
- **Web research** — Search, fetch, summarize, write reports.
- **GitHub** — Read code, list PRs, create issues, monitor repos.
- **Email** — AgentMail integration for inbox and alerts.
- **Claude Code** — Dispatches coding tasks. File editing, testing, git, PRs.
- **Self-modification** — Builds new tools into itself via Claude Code.
- **Multi-persona** — Same engine, different personality and toolset per user.

## Requirements

- Node.js 22+
- [agent-browser](https://github.com/vercel-labs/agent-browser) (for web browsing)
- Claude Code (for code dispatch)
- An API key for Anthropic, OpenRouter, or Google AI

## Quick start

```bash
npx mame init
```

Runs a conversational onboarding interview (English or Japanese). Generates all config files from your answers.

```bash
npx mame start
```

The agent is running. Message it on Discord, LINE, or the CLI:

```bash
npx mame chat
npx mame status
```

## Architecture

```
You (Discord / LINE / CLI)
 │
 ▼
Gateway ─── routes to ─── Agent Loop ─── dispatches to:
                              │
             ┌────────────────┼────────────────┐
             │                │                │
          Memory           Tools          Claude Code
       (remember)     (browser,         (actual coding)
       (recall)        web search,       (self-modify)
                       github, email,
                       report)
```

One process per persona. One SQLite database for memory. Config in `~/.mame/`.

## Model routing

Three backends, selected by prefix:

| Prefix | Backend | SDK |
|--------|---------|-----|
| _(none)_ | Anthropic direct | `@anthropic-ai/sdk` |
| `openrouter/` | OpenRouter | Anthropic-compatible API |
| `google/` | Google AI | `@google/generative-ai` |

```yaml
models:
  default: claude-sonnet-4-6-20250514          # Direct Anthropic
  heartbeat: google/gemini-3.1-flash-lite-preview  # Google AI
  complex: openrouter/anthropic/claude-opus-4-6    # Via OpenRouter
```

## Multi-persona

Same engine, different configs. One machine, multiple agents.

```yaml
# ~/.mame/personas/mike.yml — Developer workflow
name: "Mame"
models:
  default: claude-sonnet-4-6-20250514
tools: [browser, web_search, web_fetch, github, email, claude_code, memory, write_report, self_modify]

# ~/.mame/personas/yuki.yml — Personal assistant (Japanese)
name: "Siri-chan"
language: "ja"
models:
  default: google/gemini-3.1-flash-lite-preview
tools: [browser, web_search, web_fetch, memory, write_report]
```

## Config

All configuration lives in `~/.mame/`:

```
~/.mame/
├── SOUL-[name].md         # Agent personality per persona
├── HEARTBEAT.md           # Scheduled checks (natural language)
├── config.yml             # Runtime configuration
├── personas/
│   └── [name].yml         # Per-persona tools + channels
├── .vault/
│   └── [project].enc      # Encrypted secrets (AES-256-GCM)
├── browsers/
│   └── [site]/            # Persistent browser profiles
├── memory.db              # All memories (SQLite + FTS5)
└── reports/               # Generated reports
```

## CLI

```bash
mame init                      # First-time setup
mame init --persona            # Add a new persona
mame start / stop / restart    # Manage daemon
mame status                    # Health of all personas
mame chat [--project NAME]     # Interactive CLI
mame logs [persona]            # Tail logs

mame heartbeat status          # Show schedule
mame heartbeat run             # Force heartbeat

mame memory search [query]     # Search memories
mame memory list [--project]   # List memories
mame memory stats              # Counts and categories

mame secrets list [project]    # List secret keys
mame secrets set [proj] [key]  # Store a secret
mame secrets delete [proj] [key]

mame doctor                    # Full health check
```

## Documentation

- [User Guide & Configuration](mame-docs.md)
- [Technical Specification](mame-spec.md)

## License

MIT
