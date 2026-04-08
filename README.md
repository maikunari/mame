# Mame まめ

**v0.1.2** — A minimal persistent AI agent that lives on your machine, talks to you on Discord, remembers what matters, and orchestrates other agents on your behalf.

~6,000 lines of TypeScript. 17 dependencies. One SQLite file for memory. Runs on any Linux host with systemd — a home server, VPS, or cloud instance all work the same way.

まめ — *diligent, hardworking, small but mighty.*

## What it is

Mame is a personal daemon that runs on your own hardware, listens on the messaging channels you pick, and does real work: searches the web, remembers facts over time, dispatches coding tasks to Claude Code, delivers scheduled daily briefs, and — when a dispatched subtask needs your input mid-flight — pauses that subtask and asks you in Discord, then resumes when you reply.

It's not a chatbot wrapper. It's a small, opinionated agent framework built on a few strong primitives:

- **[pi-ai](https://github.com/badlogic/pi-mono)** for provider abstraction across 20+ LLM backends
- **[pi-agent-core](https://github.com/badlogic/pi-mono)** for the tool-execution loop
- **SQLite + [FTS5](https://sqlite.org/fts5.html) + [sqlite-vec](https://github.com/asg017/sqlite-vec)** for hybrid keyword + semantic memory
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** for the embedded MCP server that lets Mame orchestrate other agents
- **systemd + systemd-creds** for supervision and at-rest credential encryption (on Linux)

The whole thing is small enough to fit in your head and hackable enough to change.

## What it does

- 💬 **Multi-channel messaging** — Discord and Signal, with image attachment support for multimodal vision
- 🧠 **Hybrid memory** — FTS5 keyword search + vector similarity via sqlite-vec, fused with Reciprocal Rank Fusion; memories surface with timezone-explicit timestamps and natural-language queries find them by meaning, not just exact words
- 🕑 **Temporal awareness** — knows the current wall-clock time in your timezone on every turn; handles cross-timezone scheduling (JST ↔ EST, DST-aware) without guessing
- 📅 **Daily briefs** — morning weather + rotating theme (nature, wellness, good news, wisdom, food, culture, reflection), plus evening forecast
- 🔍 **Web research** — web search (Brave), web fetch, headless browser with persistent login sessions via agent-browser
- ✍️ **Coding dispatch** — hands file-editing, test-running, git, and PR work to Claude Code as a subprocess
- ❓ **MCP orchestration** — exposes an `ask_human` tool via an embedded MCP server; dispatched Claude Code tasks can pause mid-flight, route clarifying questions back to your Discord channel, and resume when you reply
- 🔐 **Secret safety** — refuses to store API-key-shaped content in memory; code-level pattern guard plus a SOUL-level rule
- 📝 **Structured observability** — pino JSON logs queryable via `jq`; zod-validated config fails loudly at startup instead of crashing deep in the daemon
- 🫘 **Self-modification** — reads and edits its own SOUL, HEARTBEAT, and config files via the `self_config` tool
- 👥 **Multi-persona** — same engine, different personality and toolset per user

## Architecture

```
           Discord  │  Signal  │  CLI  │  Webhooks
                    └────┬─────┘
                         │
                 ┌───────▼────────┐
                 │   Gateway      │
                 │                │
                 │  routes to ↓   │
                 └────────────────┘
                         │
                ┌────────▼────────┐
                │  pi-agent-core  │   ←── Agent loop
                │   Agent loop    │       Tool execution
                │                 │       RRF-fused recall
                └────────┬────────┘
                         │ tools
         ┌───────┬───────┼────────┬──────────┬──────────┐
         │       │       │        │          │          │
      Memory  Web     Browser  Claude    Self-config  Report
     (SQLite (Brave)  (agent-   Code    (reads own    ...
     + vec)           browser) dispatch  files)
                                  │
                     ┌────────────▼────────────┐
                     │ Claude Code (subprocess)│
                     │                         │
                     │ connects back via MCP   │
                     └────────────┬────────────┘
                                  │
                     ┌────────────▼────────────┐
                     │   MCP HTTP Server       │
                     │   (in-process,          │
                     │    port 3848)           │
                     │                         │
                     │   tool: ask_human       │
                     └────────────┬────────────┘
                                  │ routes back through
                                  ▼
                       ┌────────────────────┐
                       │ ask-human-state    │
                       │                    │
                       │ → Gateway.notify() │
                       │ → Discord delivery │
                       │ → User replies     │
                       │ → Promise resolves │
                       └────────────────────┘
```

One process per persona. One SQLite database for memory. Config in `~/.mame/`. The MCP server is embedded in the same process as the gateway and agent loop, so all three can share state.

## Hybrid memory

Every memory is stored in three places:

1. **`memories` table** — canonical rows with content, category, project, importance, `created_at`, `last_accessed`, `access_count`
2. **`memories_fts`** — FTS5 virtual table, auto-synced via triggers, indexed by BM25
3. **`memories_vec`** — sqlite-vec virtual table with 384-dim embeddings from `Xenova/all-MiniLM-L6-v2` (local, ~23MB model file, no API calls)

On `remember()`: the row is inserted, FTS5 triggers fire, and the content is embedded and stored in `memories_vec` with a matching rowid.

On `recall(query)`:
1. FTS5 keyword search (top 20 candidates, BM25 ranked)
2. In parallel, the query is embedded and sqlite-vec returns top 20 nearest neighbors by cosine similarity
3. Both result sets are fused via **[Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)** (k=60) — memories matching both layers get strictly higher scores without needing to normalize BM25 vs cosine scales
4. Recency and access count are applied as secondary tiebreakers

The result: **"lumbar discomfort"** finds the **"back pain"** memory even though they share zero tokens. Natural-language queries like *"what do you remember about Tokyo weather or Bitcoin I asked about yesterday"* surface both relevant memories without needing exact keyword matches.

Timestamps are surfaced to the model in full timezone-explicit form:

```
[2026-04-08T12:12:44+09:00 JST (3 hours ago)] User mentioned their back pain started last Tuesday
```

The model reasons about recency, timezone offsets for scheduling, and cross-timezone math (JST ↔ EST) from that anchor instead of guessing.

## MCP orchestration (Evening 6)

Mame runs an embedded MCP HTTP server on `localhost:3848` that exposes a single tool:

```
ask_human(question: string) → string
```

When Mame dispatches a coding task via the `claude_code` tool, the handler:

1. Registers a task in `ask-human-state` tagged with the dispatching Discord channel
2. Spawns `claude -p <task>` as a subprocess with `MAME_MCP_URL` in its env
3. Waits for the subprocess to exit

Claude Code's MCP client (configured via `~/.claude.json`) sees Mame's server, initializes a session, and discovers the `ask_human` tool. When Claude Code hits an ambiguous decision mid-task, it calls `ask_human("should I ...")`. Mame's MCP handler:

1. Looks at the current active task from `ask-human-state`
2. Creates a pending question, registers the resolve callback
3. Sends the question to the user's Discord channel via `gateway.notify()`
4. Returns a Promise that hangs

When the user replies in Discord, the gateway's `messageCreate` handler checks `hasPendingQuestion()`, routes the message to `provideAnswer()` instead of `think()`, and sends a one-line ack (`📨 Forwarded your answer to the running task`). The Promise resolves, Claude Code's tool call returns, and the subprocess resumes from where it paused.

Result: **Mame becomes an orchestrator**. A Discord dispatch like *"Mike, use claude_code to update all the product descriptions for the spring collection"* can turn into Claude Code pausing 5 minutes in to ask *"12 of 47 are last year's leftover stock — include them or skip?"*, Mame delivers the question to you, you reply, Claude Code resumes, and the final result lands back in Discord.

### Setup for Claude Code integration

On the machine running Mame, register the MCP server with Claude Code once:

```bash
claude mcp add --transport http mame http://localhost:3848/mcp --scope user
```

Then pre-authorize the tools you want spawned Claude Code processes to use without interactive prompts, in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "mame": {
      "type": "http",
      "url": "http://localhost:3848/mcp"
    }
  },
  "permissions": {
    "allow": [
      "mcp__mame__ask_human",
      "Write",
      "Edit",
      "Bash"
    ]
  }
}
```

## Requirements

- **Node.js 22+**
- **Linux with systemd** for the recommended deployment; macOS works for dev
- **Claude Code** (installed via `npm install -g @anthropic-ai/claude-code`) for the `claude_code` tool — optional, but you lose the coding orchestration without it
- **[agent-browser](https://github.com/vercel-labs/agent-browser)** for the `browser` tool — optional
- **API key** for at least one of: OpenRouter, Anthropic, or Google AI (via pi-ai, which supports 20+ providers natively)

## Quick start

```bash
npx mame init
```

Runs a conversational onboarding interview (English or Japanese) and generates config files from your answers — persona, SOUL, HEARTBEAT, and optionally Discord / Signal / webhook settings.

```bash
npx mame start
```

Starts the daemon. Message it from your configured channel.

For a proper production deploy on Linux, use the systemd unit file and `systemd-creds` to protect your master key — see [deployment](#deployment) below.

## Configuration

All state lives in `~/.mame/`:

```
~/.mame/
├── SOUL-[name].md         # Agent personality (loaded fresh every turn)
├── HEARTBEAT.md           # Scheduled tasks in natural language
├── config.yml             # Runtime configuration (zod-validated)
├── personas/
│   └── [name].yml         # Per-persona tools, models, channels
├── .vault/
│   └── [project].enc      # Encrypted secrets (AES-256-GCM)
│                          # Master key via MAME_MASTER_KEY env,
│                          # or systemd-creds in production
├── browsers/
│   └── [site]/            # Persistent browser profiles per site
├── memory.db              # SQLite with FTS5 + sqlite-vec
└── reports/               # Generated markdown reports
```

Config validation is enforced at startup via zod schemas — a malformed `config.yml` or `persona.yml` fails loudly with path-scoped errors instead of crashing deep in the daemon:

```
Invalid config.yml at /home/jerry/.mame/config.yml:
  - webhook.port: Expected number, received string

Fix the fields above and restart.
```

## Multi-persona

Same engine, different configs. One machine, multiple agents with distinct personalities, tools, languages, and messaging channels.

```yaml
# ~/.mame/personas/mike.yml
name: "Mame"
soul: "SOUL-Mame.md"
language: "en"
models:
  default: openrouter/qwen/qwen3.5-plus-02-15
  heartbeat: google/gemini-3.1-flash-lite-preview
tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - write_report
  - self_config
  - claude_code
discord:
  channelMap:
    "1234567890": null
```

```yaml
# ~/.mame/personas/ayaka.yml — Japanese personal assistant via Signal
name: "Siri-chan"
soul: "SOUL-Siri.md"
language: "ja"
models:
  default: openrouter/qwen/qwen3.5-plus-02-15
tools:
  - memory
  - web_search
  - web_fetch
signal:
  userNumbers:
    - "+819012345678"
```

## Model routing

Via pi-ai. Any model in any of its supported providers (Anthropic, OpenRouter, OpenAI, Google, Groq, Cerebras, Mistral, Bedrock, Vercel AI Gateway, and more) works out of the box.

```yaml
models:
  default: openrouter/qwen/qwen3.5-plus-02-15  # Primary conversation model
  heartbeat: google/gemini-3.1-flash-lite-preview  # Scheduled tasks
  complex: anthropic/claude-opus-4-5  # (Optional) escalation
```

The first path segment is the provider name; the rest is the model ID within that provider. API keys come from the vault (via `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, etc.) and are loaded into `process.env` at daemon startup.

## Heartbeat scheduler

Natural-language scheduling defined in `~/.mame/HEARTBEAT.md`. Parsed once by the LLM using pi-ai's **structured output** (via a `submit_schedule` tool with a TypeBox schema) so the model can't hallucinate entries. Uses [croner](https://github.com/Hexagon/croner) for the actual cron firing.

```markdown
## Every morning at 7:30 — DAILY REPORT (always send)
- Weather for Kamakura
- Day of the week and date
- Daily theme (nature/wellness/good news/wisdom/food/culture/reflection)

## Every evening at 18:30 — DAILY REPORT (always send)
- Tomorrow's weather outlook
- Tomorrow's agenda
```

Mame reloads the schedule whenever you save `HEARTBEAT.md` — no daemon restart needed.

## CLI

```bash
mame init                         # First-time setup
mame init --persona               # Add a new persona
mame chat [--persona NAME]        # Interactive CLI
mame heartbeat run [--persona]    # Force-run the scheduled entries
mame memory search [query]        # Search memories (FTS5 + vec hybrid)
mame memory list [--project]      # List memories
mame memory stats                 # Category/project counts
mame secrets list [project]       # List secret keys (not values)
mame secrets set [proj] [key]     # Store a secret (interactive)
mame secrets delete [proj] [key]
mame onboard-signal +NUMBER       # Start a Signal onboarding for a phone number
```

Post-cutover to systemd + systemd-creds, interactive CLI commands that need the master key require a small wrapper — see [deployment](#deployment).

## Deployment

The recommended production setup on Linux is:
1. **systemd** service for supervision, auto-restart, auto-start on boot
2. **systemd-creds** to encrypt the `MAME_MASTER_KEY` at rest with a TPM-backed or host-key-derived blob — no plaintext credentials on disk

### systemd unit (`/etc/systemd/system/mame.service`)

```ini
[Unit]
Description=Mame personal agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jerry
Group=jerry
Environment=MAME_PERSONA=mike
WorkingDirectory=/home/jerry/Projects/mame
ExecStart=/usr/bin/node /home/jerry/Projects/mame/dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Master key for the vault — encrypted at rest via systemd-creds
LoadCredentialEncrypted=MAME_MASTER_KEY:/etc/credstore.encrypted/MAME_MASTER_KEY

NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/home/jerry/.mame /home/jerry/Projects/mame

[Install]
WantedBy=multi-user.target
```

### Encrypting the master key

```bash
echo -n "$MAME_MASTER_KEY" | sudo systemd-creds encrypt \
  --name=MAME_MASTER_KEY \
  - /etc/credstore.encrypted/MAME_MASTER_KEY
```

The encrypted blob only decrypts on the same host. On boot, systemd materializes the credential into a tmpfs at `$CREDENTIALS_DIRECTORY/MAME_MASTER_KEY`, which `src/init-credentials.ts` reads into `process.env` before the vault constructs.

After encryption, remove the plaintext `MAME_MASTER_KEY` export from `~/.bashrc`.

### Interactive CLI wrapper

For running CLI commands from your shell after the systemd cutover, add to `~/.bashrc`:

```bash
mame-cli() {
  MAME_MASTER_KEY="$(sudo systemd-creds decrypt /etc/credstore.encrypted/MAME_MASTER_KEY -)" \
    node ~/Projects/mame/dist/cli.js "$@"
}
```

The key is decrypted on demand for each invocation and lives only for the duration of the command.

## Observability

Logs go to stdout as structured JSON via [pino](https://github.com/pinojs/pino). Under systemd, they land in `journalctl -u mame` with ISO 8601 timestamps and component tags:

```bash
# Human-readable stream
sudo journalctl -u mame -o cat -f

# jq queries
sudo journalctl -u mame -o cat | jq 'select(.component == "heartbeat")'
sudo journalctl -u mame -o cat | jq 'select(.level >= 40)'  # warnings and up
sudo journalctl -u mame -o cat | jq -r '[.time, .component, .msg] | @tsv'
```

Health endpoint for the MCP server and active-task state:

```bash
curl http://localhost:3848/health
# {"ok":true,"activeSessions":0,"activeTask":null}
```

## Security model

- **Vault** — secrets stored AES-256-GCM encrypted in `~/.mame/.vault/`; decrypted into `process.env` at daemon startup using a master key that lives **only** in the systemd credential tmpfs during service runtime (never on disk in plaintext post-cutover)
- **Secret detection** — `memory.remember()` refuses to store content matching known API key patterns (OpenAI `sk-`, Anthropic, Brave `BSA`, GitHub `ghp_`, Google `AIza`, Slack `xoxb-`, AWS `AKIA`, JWT, 64-char hex, long base64). Plus a SOUL-level rule instructing the agent to refuse even without the code guard.
- **Tool approval** — destructive actions (deploy, delete, send external email) are gated by explicit confirmation in the SOUL
- **Localhost-only MCP server** — the embedded MCP server binds to `127.0.0.1` and is never exposed to the network
- **Systemd sandboxing** — `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`, `ReadWritePaths` scoped to only `~/.mame` and the project directory

## Dependencies

- **[@mariozechner/pi-ai](https://github.com/badlogic/pi-mono)** — provider abstraction across 20+ LLM backends
- **[@mariozechner/pi-agent-core](https://github.com/badlogic/pi-mono)** — agent loop with tool execution, retry, streaming events
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP HTTP server + client
- **[sqlite-vec](https://github.com/asg017/sqlite-vec)** — vector similarity search as a SQLite extension
- **[@xenova/transformers](https://github.com/xenova/transformers.js)** — local embedding model (~23MB, no API calls)
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — synchronous SQLite with FTS5
- **[croner](https://github.com/Hexagon/croner)** — TypeScript-native cron
- **[pino](https://github.com/pinojs/pino)** — structured JSON logging
- **[znv](https://github.com/lostfictions/znv) + [zod](https://github.com/colinhacks/zod)** — runtime config and env var validation
- **[p-retry](https://github.com/sindresorhus/p-retry)** — exponential backoff for transient tool errors
- **[discord.js](https://discord.js.org/)** — Discord gateway
- **[@octokit/rest](https://github.com/octokit/rest.js)** — GitHub API
- **[express](https://expressjs.com/)** — webhook server + MCP HTTP server
- **[yaml](https://github.com/eemeli/yaml)** — config parsing
- signal-cli (system package) — Signal channel via daemon mode

## Documentation

- [Technical Specification](mame-spec.md)
- [User Guide & Configuration](mame-docs.md)

## License

MIT

---

*まめ — diligent, hardworking, small but mighty.*
