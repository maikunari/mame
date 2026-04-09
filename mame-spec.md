# Mame まめ: Minimal Persistent Agent — v0.1.2

**A thin orchestration layer that connects you to Claude Code, the web, your repos, and your email — and gets smarter over time.**

*TypeScript. Simple. Elegant.*

---

## What Mame Is

Mame is not an AI agent framework. It's not a platform. It's a personal daemon that sits on a Linux host, listens for messages, thinks about them using Claude (or Gemma 4 for lightweight instances), and dispatches work to the right place. It has seven capabilities:

1. **Self-improving memory** — SQLite + FTS5 (upgradeable to Antakarana later)
2. **Web browsing with persistent logins** — agent-browser with saved profiles and encrypted credentials
3. **Web research** — search, fetch, summarize, write reports
4. **GitHub repo access** — read code, create PRs, monitor repos
5. **Email & Discord** — receive alerts, send updates, take commands
6. **Claude Code orchestration** — dispatch coding tasks, monitor progress
7. **Self-modification** — builds new tools into itself via Claude Code

Everything else is someone else's problem.

**Multi-persona capable.** Same engine, different SOUL.md and toolset per user. Developers get Claude Code + GitHub + full toolkit. Non-coders get browser + calendar + shopping + memory. Swap the config, swap the personality.

---

## Architecture

```
You (Discord / Email / CLI)
 │
 ▼
Gateway ──── routes to ──── Agent Loop ──── dispatches to:
                               │
              ┌────────────────┼────────────────┐
              │                │                │
           Memory           Tools          Claude Code
        (remember)     (browser,         (actual coding)
        (recall)        web search,       (self-modify)
                        github,
                        email,
                        report)
```

That's it. One process. One event loop. One SQLite database for memory. One config file. One `agent-browser` instance with persistent profiles.

---

## The Agent Loop (The Whole Brain)

```typescript
// src/agent.ts — this is the entire reasoning engine

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

interface Turn {
  message: string;
  channel: string;        // 'discord' | 'line' | 'email' | 'webhook' | 'cli' | 'heartbeat'
  project?: string;       // matched project context, if any
  personaId: string;      // persona name for conversation buffer keying
  soulFile: string;       // path to SOUL.md
  model: string;          // model string (routed by prefix: google/, openrouter/, or direct)
  tools: string[];        // enabled tool names for this persona
}

// Conversation buffer keyed by personaId:channelId — last ~20 messages
// TODO: optional SQLite persistence for non-technical personas who need cross-restart continuity
const conversationBuffer = new Map<string, ChatMessage[]>();
const MAX_BUFFER_SIZE = 20;

async function think(turn: Turn): Promise<string> {
  try {
    // 1. Recall relevant memories
    const memories = await recall(turn.message, turn.project);

    // 2. Load project context if matched
    const projectContext = turn.project
      ? await loadProjectContext(turn.project)
      : "";

    // 3. Assemble system prompt
    const soul = loadSoul(turn.soulFile);
    const system = buildSystemPrompt({ soul, memories, projectContext });

    // 4. Build messages with conversation history
    const bufferKey = `${turn.personaId}:${turn.channel}:${turn.project || "global"}`;
    const history = conversationBuffer.get(bufferKey) || [];
    const messages = [...history, { role: "user" as const, content: turn.message }];

    // 5. Run agent loop with tools (model routed by prefix)
    const tools = getToolDefinitions(turn.tools);
    let response = await chatCompletion(turn.model, system, messages, tools);

    // 6. Execute tool calls until done
    while (response.stop_reason === "tool_use") {
      const toolResults = await executeToolCalls(response.content, turn);
      messages.push({ role: "assistant" as const, content: response.content });
      messages.push({ role: "user" as const, content: toolResults });
      response = await chatCompletion(turn.model, system, messages, tools);
    }

    // 7. Extract text response
    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // 8. Update conversation buffer
    const updatedHistory = [...history, { role: "user", content: turn.message }, { role: "assistant", content: reply }];
    conversationBuffer.set(bufferKey, updatedHistory.slice(-MAX_BUFFER_SIZE));

    // 9. Remember what happened (agent decides what's worth storing)
    await maybeRemember(turn.message, reply, turn.project);

    return reply;
  } catch (error) {
    // Outer catch — keeps the daemon alive
    console.error(`[agent] think() error: ${error}`);
    return `Something went wrong: ${error instanceof Error ? error.message : error}`;
  }
}
```

---

## System Prompt Assembly

```typescript
// src/prompt.ts

function buildSystemPrompt({ memories, projectContext }): string {
  return `${SOUL}

${projectContext ? `## Current Project\n${projectContext}` : ""}

${memories.length ? `## Relevant Memories\n${memories.map((m) => `- ${m.content}`).join("\n")}` : ""}

## Tools Available
You have tools for: web search, web fetch, browser (with persistent logins),
GitHub operations, email (AgentMail), Claude Code dispatch, memory, and reports.
Use them as needed.

## Rules
- For any code changes, ALWAYS dispatch to Claude Code. Never write code yourself.
- For destructive actions (deploy, delete, send email to external), ask for approval first.
- After completing complex tasks, store key learnings in memory.
- Be concise in Discord. Be detailed in reports.`;
}
```

Where `SOUL` is a markdown file you edit directly:

```markdown
# ~/.mame/SOUL.md

You are Mame, a persistent AI agent running on a Linux host.
You help manage software projects, monitor infrastructure,
research topics, and coordinate coding work via Claude Code.

You communicate primarily through Discord. You are direct, technical,
and don't waste words. You know your person's projects, preferences, and workflows
because you remember them.

You are proactive during heartbeats but not annoying — only notify
if something actually needs attention.
```

---

## Tools (8 Total)

### 1. Browser (agent-browser)

The primary interface with the web. Persistent profiles mean login once, stay logged in. Credentials in the vault. Re-auth handled automatically.

```typescript
// src/tools/browser.ts

import { execFile } from "child_process";

const browserTool = {
  name: "browser",
  description:
    "Browse the web with persistent login sessions. Use for any website interaction — shopping, dashboards, authenticated pages, form filling, data extraction.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "open",           // Navigate to URL
          "snapshot",       // Get page structure with element refs
          "screenshot",     // Visual capture (needs vision model)
          "click",          // Click element by ref
          "type",           // Type into element by ref
          "extract",        // Extract text/data from page
          "scroll",         // Scroll page
          "back",           // Navigate back
          "wait",           // Wait for element/condition
        ],
      },
      url: { type: "string" },
      ref: {
        type: "string",
        description: "Element reference from snapshot (e.g. @e1, @e2)",
      },
      text: { type: "string", description: "Text to type or search for" },
      profile: {
        type: "string",
        description:
          "Named profile for session persistence (e.g. 'amazon-jp', 'newrelic')",
      },
    },
    required: ["action"],
  },
};

// All browser commands go through agent-browser CLI
async function execute(input: any, ctx: ToolContext) {
  const args: string[] = [];

  // Use persistent profile if specified
  if (input.profile) {
    args.push("--profile", `${MAME_HOME}/browsers/${input.profile}`);
  }

  switch (input.action) {
    case "open":
      args.push("open", input.url);
      break;
    case "snapshot":
      args.push("snapshot");    // Returns element refs for interaction
      break;
    case "screenshot":
      const screenshotPath = `/tmp/mame-screenshot-${Date.now()}.png`;
      args.push("screenshot", "--annotate", screenshotPath);
      return { path: screenshotPath };
    case "click":
      args.push("click", input.ref);
      break;
    case "type":
      args.push("type", input.ref, input.text);
      break;
    case "extract":
      args.push("extract", "--text");
      break;
    case "scroll":
      args.push("scroll", input.text || "down");
      break;
    case "back":
      args.push("back");
      break;
    case "wait":
      args.push("wait", input.text);
      break;
  }

  return new Promise((resolve) => {
    execFile("agent-browser", args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ success: !err, output: stdout, error: stderr || err?.message });
    });
  });
}
```

**Login flow — how it actually works:**

```
You: "Set up my Amazon Japan account"

Mame: "I'll create a browser profile for Amazon.
         What's your email and password?"

You: "user@example.com / mypassword123"

Mame: → vault.set('amazon-jp', 'email', 'user@example.com')
        → vault.set('amazon-jp', 'password', 'mypassword123')
        → browser open amazon.co.jp --profile amazon-jp
        → browser snapshot → finds login form
        → browser type @email-field user@example.com
        → browser type @password-field mypassword123
        → browser click @submit
        → detects 2FA prompt
        "2FA code needed — check your phone:"

You: "482910"

Mame: → browser type @2fa-field 482910
        → browser click @submit
        → session cookies saved in profile
        "Logged in. I'll remember this session."
```

From now on, `--profile amazon-jp` reuses the saved cookies. If the session expires, the agent detects the login page, pulls credentials from the vault, and only asks for a fresh 2FA code if needed.

**Browser profiles persist in:**
```
~/.mame/browsers/
├── amazon-jp/          # Amazon Japan session
├── newrelic/           # New Relic dashboard
├── github/             # GitHub (backup to API)
├── vercel/             # Deployment dashboard
└── default/            # General browsing, no auth
```

### 2. Web Search

For research tasks that don't need a full browser session.

```typescript
// src/tools/web.ts

const webSearchTool = {
  name: "web_search",
  description: "Search the web and return results",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
};

const webFetchTool = {
  name: "web_fetch",
  description: "Fetch and extract content from a URL (no auth needed)",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
  },
};

// Implementation: Brave Search API (free tier: 2000 queries/month)
// or Serper API ($50/month for 50K queries)
// Fetch: simple cheerio extraction, no browser overhead
```

### 2. GitHub

```typescript
// src/tools/github.ts

const githubTool = {
  name: "github",
  description: "Interact with GitHub repositories",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [
          "list_repos",
          "read_file",
          "list_prs",
          "create_issue",
          "get_pr",
          "list_notifications",
          "search_code",
        ],
      },
      repo: { type: "string", description: "owner/repo" },
      path: { type: "string" },
      query: { type: "string" },
      pr_number: { type: "number" },
    },
    required: ["action"],
  },
};

// Implementation: @octokit/rest — straightforward REST wrapper
// Token from secrets vault
```

### 3. Email (AgentMail)

```typescript
// src/tools/email.ts

const emailTool = {
  name: "email",
  description: "Read, search, and send emails via AgentMail",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["check_inbox", "read_thread", "send", "search"],
      },
      thread_id: { type: "string" },
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      query: { type: "string" },
    },
    required: ["action"],
  },
};

// Implementation: AgentMail REST API — fetch calls with API key from vault
```

### 4. Claude Code Dispatch

```typescript
// src/tools/claude-code.ts

import { execFile } from "child_process";

const claudeCodeTool = {
  name: "claude_code",
  description:
    "Dispatch a coding task to Claude Code. Use for ALL code changes.",
  input_schema: {
    type: "object" as const,
    properties: {
      project: {
        type: "string",
        description: "Project name (maps to local path)",
      },
      task: {
        type: "string",
        description: "What to do — be specific and detailed",
      },
      await_result: {
        type: "boolean",
        description: "Wait for completion (true) or fire-and-forget (false)",
      },
    },
    required: ["project", "task"],
  },
};

async function executeClaude(input: {
  project: string;
  task: string;
  await_result?: boolean;
}) {
  const projectPath = config.projects[input.project]?.path;
  if (!projectPath) return { error: `Unknown project: ${input.project}` };

  const env = await vault.getAll(input.project);

  // claude -p runs Claude Code in non-interactive mode
  // It handles its own file access, git, testing, etc.
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "claude",
      ["-p", input.task],
      {
        cwd: projectPath,
        env: { ...process.env, ...env },
        timeout: input.await_result ? 600000 : undefined, // 10 min timeout if awaiting
      },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: stdout,
          error: stderr || error?.message,
        });
      }
    );

    if (!input.await_result) {
      resolve({ dispatched: true, pid: proc.pid });
    }
  });
}
```

### 7. Memory

50 lines. No vector database. No external API calls. Just SQLite + FTS5.

```typescript
// src/memory.ts

import Database from "better-sqlite3";

const db = new Database(`${MAME_HOME}/memory.db`);

// Schema — one table, one FTS5 index with content= auto-sync
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    project TEXT,
    category TEXT DEFAULT 'general',
    importance REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed DATETIME,
    access_count INTEGER DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, project, category, content=memories, content_rowid=id);

  -- Triggers to keep FTS5 in sync with the memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, project, category)
    VALUES (new.id, new.content, new.project, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, project, category)
    VALUES ('delete', old.id, old.content, old.project, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, project, category)
    VALUES ('delete', old.id, old.content, old.project, old.category);
    INSERT INTO memories_fts(rowid, content, project, category)
    VALUES (new.id, new.content, new.project, new.category);
  END;
`);

export async function remember(
  content: string,
  project?: string,
  category?: string,
  importance?: number
) {
  db.prepare(
    "INSERT INTO memories (content, project, category, importance) VALUES (?, ?, ?, ?)"
  ).run(content, project, category || "general", importance || 0.5);
}

export async function recall(query: string, project?: string, limit = 10) {
  const results = db
    .prepare(
      `
    SELECT m.*, rank
    FROM memories_fts fts
    JOIN memories m ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
    ${project ? "AND m.project = ?" : ""}
    ORDER BY rank * 0.6
           + (1.0 / (1 + julianday('now') - julianday(m.created_at))) * 0.2
           + (m.access_count * 0.01) * 0.2
    LIMIT ?
  `
    )
    .all(project ? [query, project, limit] : [query, limit]);

  // Update access stats
  for (const r of results as any[]) {
    db.prepare(
      "UPDATE memories SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?"
    ).run(r.id);
  }

  return results;
}

export async function forget(id: number) {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}
```

**The MCP tool interface:**

```typescript
// src/tools/memory.ts

const memoryTool = {
  name: "memory",
  description: "Store and retrieve memories. The agent decides what's worth remembering.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["remember", "recall", "forget"] },
      content: { type: "string", description: "What to remember or search for" },
      project: { type: "string", description: "Project scope (optional)" },
      category: {
        type: "string",
        enum: ["learning", "preference", "decision", "skill", "person", "general"],
      },
      importance: {
        type: "number",
        description: "0-1 importance score (default 0.5)",
      },
      id: { type: "number", description: "Memory ID (for forget)" },
    },
    required: ["action"],
  },
};
```

**How it works in practice:**

The agent IS the discrimination layer. When something important happens, the agent calls `memory.remember()` with the right category and importance. The skill extraction in `improve.ts` auto-stores learnings after complex tasks. FTS5 handles retrieval with recency and frequency boosting. No side-calls, no latency, no extra API costs.

**Why this is enough for v1:**

- OpenClaw uses flat markdown files. This is already better — searchable, scored, structured.
- Hermes uses FTS5 + LLM summarization. This matches their approach.
- The `remember()` / `recall()` interface is stable. When Antakarana is ready, swap the implementation. Nothing else changes.

**Upgrade path to Antakarana (v2):**

```
v1: SQLite + FTS5 (ships now, 50 lines)
v2: Add Zvec embeddings for semantic search
v3: Add Buddhi discrimination layer (Gemini Flash)
v4: Add Triguna lifecycle scoring
v5: Add Adhyavasaya feedback loop
```

Each step is additive. The interface never changes. Build the agent, get it running, then make the memory philosophical.

### 6. Write Report

```typescript
// src/tools/report.ts

const reportTool = {
  name: "write_report",
  description: "Write a structured report to a file",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
      content: { type: "string", description: "Full markdown content" },
      destination: {
        type: "string",
        enum: ["file", "discord", "email"],
        description: "Where to deliver the report",
      },
      filename: { type: "string", description: "If destination is file" },
    },
    required: ["title", "content", "destination"],
  },
};

// Implementation: fs.writeFile for files, gateway.send for discord,
// email tool for email delivery. Reports go to ~/.mame/reports/
```

### 8. Self-Modify

The tool that makes Mame grow. Dispatches Claude Code to modify Mame's own codebase.

```typescript
// src/tools/self-modify.ts

const selfModifyTool = {
  name: "self_modify",
  description:
    "Add new capabilities to Mame by creating or modifying tools. " +
    "ALWAYS requires user approval. Follow existing patterns in src/tools/.",
  input_schema: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description: "What capability to add or change",
      },
      restart: {
        type: "boolean",
        description: "Restart after changes (default true)",
      },
    },
    required: ["task"],
  },
  requiresApproval: true, // ALWAYS — non-negotiable
};

async function execute(input: any) {
  const result = await claudeCode.run({
    cwd: MAME_PROJECT_PATH,
    prompt: `${input.task}

RULES:
- Follow existing patterns in src/tools/. Each tool = one file.
- Register new tools in src/tools/index.ts.
- Add any new npm dependencies needed.
- DO NOT modify src/agent.ts, src/gateway.ts, or src/memory.ts.
- Write clean, minimal code. Match the style of existing tools.
- Test that the tool schema is valid JSON.`,
  });

  if (input.restart !== false) {
    execSync("pm2 restart all");
  }

  // Store the skill as a memory for future reference
  await remember(
    `Built new tool: ${input.task}`,
    "mame",
    "skill",
    0.9
  );

  return result;
}
```

**How it grows over time:**

```
src/tools/
├── index.ts          # Day 1 — registry
├── browser.ts        # Day 1 — agent-browser
├── web.ts            # Day 1 — search + fetch
├── github.ts         # Day 1 — repo operations
├── email.ts          # Day 1 — AgentMail
├── claude-code.ts    # Day 1 — code dispatch
├── memory.ts         # Day 1 — remember/recall
├── report.ts         # Day 1 — write reports
├── self-modify.ts    # Day 1 — builds new tools
│
│ ── everything below was built by Mame itself ──
│
├── vercel.ts         # Week 2 — "can you monitor my deployments?"
├── newrelic.ts       # Week 2 — "can you check New Relic directly?"
├── stripe.ts         # Week 3 — "can you pull my revenue numbers?"
├── calendar.ts       # Week 3 — built for wife's instance
├── shopping.ts       # Week 4 — price tracking for wife
├── supabase.ts       # Month 2 — database monitoring
├── lighthouse.ts     # Month 2 — performance auditing
├── social-post.ts    # Month 2 — content publishing
└── slack.ts          # Month 3 — Friendly Fires team wanted it
```

Every new tool follows the same pattern. Every modification is a git commit. If something breaks, `git revert` and restart.

---

## Multi-Persona Instances

Same engine, different configs. One host, multiple agents.

```yaml
# ~/.mame/personas/default.yml
name: "Mame"
soul: "SOUL-Mame.md"
models:
  default: claude-sonnet-4-6-20250514
  heartbeat: google/gemini-3.1-flash-lite-preview
  complex: openrouter/anthropic/claude-opus-4-6
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
    "123456791": mame
```

```yaml
# ~/.mame/personas/yuki.yml
name: "Siri-chan"
soul: "SOUL-yuki.md"
language: "ja"
models:
  default: google/gemini-3.1-flash-lite-preview    # $0.25/M input — lightweight and fast
  heartbeat: google/gemini-3.1-flash-lite-preview
tools:
  - browser
  - web_search
  - memory
  - report
  # No claude_code, no github, no self_modify
line:
  userIds:
    - "U1234567890abcdef"         # Yuki's LINE user ID
```

```markdown
# ~/.mame/SOUL-yuki.md

You are Yuki's personal assistant. You help with:
- Finding and tracking products online (Amazon JP, Rakuten, etc.)
- Managing the family calendar
- Researching restaurants, travel, activities
- Remembering preferences and important dates

You communicate in Japanese and English (follow her lead).
You are warm, helpful, and proactive about reminders.
You never make purchases without explicit confirmation.
```

**Startup with multiple personas:**

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "mame-default",
      script: "./dist/index.js",
      args: "--persona default",
      env: { MAME_HOME: "~/.mame" },
    },
    {
      name: "mame-yuki",
      script: "./dist/index.js",
      args: "--persona yuki",
      env: { MAME_HOME: "~/.mame" },
    },
  ],
};
```

Two agents, one machine, separate Discord channels, separate memories, separate tool permissions. The family-assistant instance runs on Gemini Flash Lite for pennies. The developer instance runs on Claude for power. Both use the same core code.

---

## Gateway (Ears & Mouth)

```typescript
// src/gateway.ts

import { Client, GatewayIntentBits } from "discord.js";
import { messagingApi, middleware } from "@line/bot-sdk";
import express from "express";
import readline from "readline";
import { think } from "./agent";

class Gateway {
  private discord: Client;
  private line: messagingApi.MessagingApiClient;
  private webhookServer: express.Application;

  async start() {
    if (config.discord?.enabled) await this.startDiscord();
    if (config.line?.enabled) await this.startLINE();
    await this.startWebhooks();
    this.startTUI();
    console.log("🫘 Mame is awake.");
  }

  // --- Discord ---
  private async startDiscord() {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.discord.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;

      const project = config.discord.channelMap[msg.channelId] || undefined;

      const reply = await think({
        message: msg.content,
        channel: "discord",
        project,
      });

      for (const chunk of splitMessage(reply, 2000)) {
        await msg.reply(chunk);
      }
    });

    await this.discord.login(await vault.get("global", "DISCORD_BOT_TOKEN"));
  }

  // --- LINE (acknowledge-then-push pattern) ---
  private async startLINE() {
    const channelAccessToken = await vault.get("global", "LINE_CHANNEL_ACCESS_TOKEN");
    const channelSecret = await vault.get("global", "LINE_CHANNEL_SECRET");

    this.line = new messagingApi.MessagingApiClient({ channelAccessToken });

    // LINE uses webhooks — register handler on the Express server
    this.webhookServer.post(
      "/line/webhook",
      middleware({ channelSecret }),
      async (req, res) => {
        res.status(200).end();

        for (const event of req.body.events) {
          if (event.type !== "message" || event.message.type !== "text") continue;

          const userId = event.source.userId;
          const project = config.line?.userMap?.[userId] || undefined;

          // Acknowledge immediately to use the free reply token (~30s expiry)
          try {
            await this.line.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: "🫘" }],
            });
          } catch {
            // Reply token may already be expired, that's fine
          }

          // Process the message (may take >30s for complex tasks)
          const reply = await think({
            message: event.message.text,
            channel: "line",
            project,
          });

          // Send the real response via pushMessage (LINE 5000 char limit)
          for (const chunk of splitMessage(reply, 5000)) {
            await this.line.pushMessage({
              to: userId,
              messages: [{ type: "text", text: chunk }],
            });
          }
        }
      }
    );
  }

  // --- Webhooks (New Relic, GitHub, AgentMail) ---
  private async startWebhooks() {
    this.webhookServer = express();
    this.webhookServer.use(express.json());

    this.webhookServer.post("/webhook/:source", async (req, res) => {
      const message = parseWebhook(req.params.source, req.body);
      const project = routeWebhookToProject(req.params.source, req.body);

      res.status(200).json({ received: true });

      const reply = await think({ message, channel: "webhook", project });
      await this.notify(project, reply);
    });

    const port = config.webhook?.port || 3847;
    this.webhookServer.listen(port);
  }

  // --- TUI (Terminal UI) ---
  private startTUI() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question("🫘 mame> ", async (input) => {
        if (input === "exit") process.exit(0);

        // TUI commands
        if (input.startsWith("/")) {
          await this.handleTUICommand(input);
        } else {
          const reply = await think({ message: input, channel: "cli" });
          console.log(`\n${reply}\n`);
        }
        prompt();
      });
    };

    prompt();
  }

  private async handleTUICommand(input: string) {
    const [cmd, ...args] = input.slice(1).split(" ");
    switch (cmd) {
      case "status":
        console.log(await getStatus());
        break;
      case "memory":
        console.log(await searchMemory(args.join(" ")));
        break;
      case "heartbeat":
        console.log("Running heartbeat...");
        await runHeartbeat();
        break;
      case "cost":
        console.log(await getCostReport());
        break;
      case "secrets":
        console.log(await listSecrets(args[0]));
        break;
      case "doctor":
        console.log(await runDoctor());
        break;
      case "help":
        console.log(`
  /status     — Show agent health
  /memory     — Search memories
  /heartbeat  — Force heartbeat
  /cost       — API cost report
  /secrets    — List secret keys
  /doctor     — Full health check
  /help       — This message
        `);
        break;
      default:
        console.log(`Unknown command: /${cmd}. Type /help for commands.`);
    }
  }

  // Send notification to user's preferred channel
  async notify(project: string | undefined, message: string) {
    // Try Discord first, then LINE
    if (this.discord) {
      const channelId = project
        ? Object.entries(config.discord.channelMap).find(
            ([, p]) => p === project
          )?.[0]
        : config.discord.defaultChannel;

      if (channelId) {
        const channel = await this.discord.channels.fetch(channelId);
        for (const chunk of splitMessage(message, 2000)) {
          await (channel as any).send(chunk);
        }
        return;
      }
    }

    if (this.line && config.line?.defaultUserId) {
      for (const chunk of splitMessage(message, 5000)) {
        await this.line.pushMessage({
          to: config.line.defaultUserId,
          messages: [{ type: "text", text: chunk }],
        });
      }
    }
  }
}
```

---

## Heartbeat (The Pulse)

HEARTBEAT.md is the single source of truth. No hardcoded crons. On startup (and on file change), the scheduler reads HEARTBEAT.md and uses the heartbeat model to parse natural language schedules into cron expressions.

```typescript
// src/heartbeat.ts

import cron from "node-cron";
import { watch } from "fs";
import { think } from "./agent";
import { chatCompletion } from "./model-router";

class HeartbeatScheduler {
  private jobs: cron.ScheduledTask[] = [];

  async start() {
    await this.loadSchedule();

    // Reload when HEARTBEAT.md changes
    watch(`${MAME_HOME}/HEARTBEAT.md`, async () => {
      console.log("HEARTBEAT.md changed, reloading schedule...");
      await this.loadSchedule();
    });
  }

  private async loadSchedule() {
    // Clear existing jobs
    this.jobs.forEach((j) => j.stop());
    this.jobs = [];

    const raw = fs.readFileSync(`${MAME_HOME}/HEARTBEAT.md`, "utf-8");

    // Use the heartbeat model to parse natural language → cron expressions
    const entries = await parseSchedule(raw);

    for (const entry of entries) {
      const job = cron.schedule(entry.cron, async () => {
        const reply = await think({
          message: entry.prompt,
          channel: "heartbeat",
        });

        // Only notify if something needs attention
        if (!reply.includes("ALL_CLEAR")) {
          await gateway.notify(entry.project, `💓 ${reply}`);
        }
      }, { timezone: config.timezone || "Asia/Tokyo" });

      this.jobs.push(job);
    }
  }
}

async function parseSchedule(markdown: string) {
  const response = await chatCompletion(
    config.models.heartbeat,  // Gemini Flash Lite or similar cheap model
    "You are a schedule parser.",
    [{
      role: "user",
      content: `Parse this heartbeat schedule into JSON.
Return an array of: { cron: "cron expression", prompt: "what to check", project: "project or null" }

${markdown}`
    }],
    [],
    2000
  );

  return JSON.parse(extractText(response));
}
```

```markdown
# ~/.mame/HEARTBEAT.md

Check the following and respond ALL_CLEAR if nothing needs attention.
Only alert me if something is genuinely wrong or needs action.

- Check agentmail inbox for new messages
- Check GitHub notifications across all repos
- Quick health check: are all production sites responding?
```

---

## Secrets Vault (Keep It Simple)

```typescript
// src/vault.ts

import crypto from "crypto";

// AES-256-GCM encrypted JSON files, one per project
// Master key loaded from OS keychain or MAME_MASTER_KEY env var

class Vault {
  async get(project: string, key: string): Promise<string> {
    const secrets = await this.load(project);
    return secrets[key];
  }

  async getAll(project: string): Promise<Record<string, string>> {
    return this.load(project);
  }

  async set(project: string, key: string, value: string): Promise<void> {
    const secrets = await this.load(project);
    secrets[key] = value;
    await this.save(project, secrets);
  }

  private async load(project: string): Promise<Record<string, string>> {
    const file = path.join(MAME_HOME, ".vault", `${project}.enc`);
    if (!fs.existsSync(file)) return {};
    const encrypted = fs.readFileSync(file);
    return JSON.parse(decrypt(encrypted, this.masterKey));
  }

  private async save(
    project: string,
    secrets: Record<string, string>
  ): Promise<void> {
    const file = path.join(MAME_HOME, ".vault", `${project}.enc`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encrypt(JSON.stringify(secrets), this.masterKey));
  }
}
```

---

## Self-Improvement (Skill Extraction)

This is the learning loop. After complex multi-tool tasks (5+ tool calls), the agent reflects:

After complex multi-tool tasks (5+ tool calls), the agent reflects:

```typescript
// src/improve.ts

async function maybeExtractSkill(
  conversation: Message[],
  toolCallCount: number
) {
  if (toolCallCount < 5) return; // Only for complex tasks

  const extraction = await anthropic.messages.create({
    model: config.models.heartbeat || config.models.default, // Use cheap heartbeat model
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Review this task execution. If you solved something non-trivial
that might come up again, write a concise skill document.

If this was routine and not worth documenting, reply SKIP.

Conversation:
${JSON.stringify(conversation)}

Format if documenting:
## [Skill Name]
**When to use:** [trigger conditions]
**Steps:** [what to do]
**Gotchas:** [things that tripped you up]`,
      },
    ],
  });

  const text = extraction.content[0]?.type === "text"
    ? extraction.content[0].text
    : "";
  if (text === "SKIP") return;

  // Store as a memory with high importance
  await remember(text, undefined, "skill", 0.9);
}
```

Over time, Mame accumulates skills that get recalled when similar tasks come up. The system gets meaningfully smarter each month — not through any exotic architecture, just through the agent storing what worked and retrieving it next time.

---

## Config

```yaml
# ~/.mame/config.yml

# Projects — each maps to a local path and optional Discord channel
projects:
  kantan-finance:
    path: ~/Projects/kantan-finance
    github: yourusername/kantan-finance
  jozu:
    path: ~/Projects/jozu
    github: yourusername/jozu
  mame:
    path: ~/Projects/mame
    github: yourusername/mame

# Discord (developer workflow)
discord:
  enabled: true
  channelMap:
    "123456789": kantan-finance
    "123456790": jozu
    "123456791": mame
    "123456792": null            # general — no project context
  defaultChannel: "123456792"

# LINE (personal assistant)
line:
  enabled: true
  userMap:
    "U1234567890abcdef": null    # Yuki — global context
  defaultUserId: "U1234567890abcdef"

# Webhooks
webhook:
  port: 3847

# AgentMail
agentmail:
  pollInterval: 60               # seconds between inbox checks

# Models (three backends: no prefix = Anthropic, google/ = Google AI, openrouter/ = OpenRouter)
models:
  default: claude-sonnet-4-6-20250514
  heartbeat: google/gemini-3.1-flash-lite-preview
  complex: openrouter/anthropic/claude-opus-4-6
```

---

## File Structure

```
mame/
├── src/
│   ├── agent.ts          # Agent loop + conversation buffer (~125 lines)
│   ├── model-router.ts   # Three-backend model routing (~199 lines)
│   ├── prompt.ts         # System prompt assembly (~28 lines)
│   ├── gateway.ts        # Discord + LINE + webhooks + TUI (~314 lines)
│   ├── heartbeat.ts      # HEARTBEAT.md parser + cron scheduler (~161 lines)
│   ├── vault.ts          # AES-256-GCM encrypted secrets (~90 lines)
│   ├── memory.ts         # SQLite + FTS5 + triggers (~142 lines)
│   ├── improve.ts        # Skill extraction (~53 lines)
│   ├── config.ts         # Load config + persona (~84 lines)
│   ├── onboard.ts        # Onboarding interview (~179 lines)
│   ├── index.ts          # Daemon entry point (~58 lines)
│   ├── cli.ts            # CLI entry point (~281 lines)
│   └── tools/
│       ├── index.ts      # Tool registry + retry + error handling (~126 lines)
│       ├── browser.ts    # agent-browser wrapper (~112 lines)
│       ├── web.ts        # Web search + fetch (~106 lines)
│       ├── github.ts     # GitHub operations (~119 lines)
│       ├── email.ts      # AgentMail (~87 lines)
│       ├── claude-code.ts # Dispatch to Claude Code (~73 lines)
│       ├── memory-tool.ts # Memory tool interface (~64 lines)
│       ├── report.ts     # Write reports (~61 lines)
│       └── self-modify.ts # Self-modification (~83 lines)
├── package.json
├── tsconfig.json
└── ecosystem.config.cjs  # pm2 config (auto-discovers personas)

~/.mame/
├── SOUL-Mame.md           # Primary agent personality
├── SOUL-alt.md            # Alternate persona personality
├── HEARTBEAT.md           # Heartbeat checklist
├── config.yml             # Runtime config
├── personas/
│   ├── default.yml        # Primary tool + channel config
│   └── alt.yml            # Alternate persona config
├── .vault/                # Encrypted secrets
│   ├── global.enc
│   ├── kantan-finance.enc
│   ├── amazon-jp.enc
│   └── jozu.enc
├── browsers/              # agent-browser persistent profiles
│   ├── amazon-jp/
│   ├── newrelic/
│   ├── rakuten/
│   └── default/
├── memory.db              # All memories (SQLite + FTS5)
└── reports/               # Generated reports
```

**Total application code: ~2,545 lines of TypeScript.**

One SQLite file for all memory. Portable — copy `memory.db` to migrate anywhere. Backed up with a single `cp` command. Greppable with `sqlite3 memory.db "SELECT * FROM memories WHERE content LIKE '%moneris%'"`. No vector database. No embedding API. No dependencies beyond `better-sqlite3` which you already use.

**Upgrade path:** When Antakarana is ready, replace `src/memory.ts` internals. The `remember()` / `recall()` interface stays the same. Everything else is untouched.

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@google/generative-ai": "latest",
    "@line/bot-sdk": "^9.0.0",
    "@octokit/rest": "^20.0.0",
    "better-sqlite3": "^11.0.0",
    "discord.js": "^14.0.0",
    "express": "^4.18.0",
    "node-cron": "^3.0.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/node": "^22.0.0",
    "@types/node-cron": "^3.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

Nine npm dependencies. Plus two global CLI tools:

```bash
npm install -g agent-browser    # Browser automation with persistent profiles
# Claude Code already installed on the host
```

For lightweight personas, use Google AI (Gemini Flash Lite) via the `google/` model prefix.
No local model setup required for v1.

---

## Startup & Onboarding

```bash
# Install
npx mame init
```

That's it. Everything else happens through conversation.

### The Onboarding Interview

`mame init` creates `~/.mame/`, installs dependencies, then launches the agent loop in CLI mode for an onboarding interview. The agent asks questions, you answer, and it generates all config files from your responses.

```typescript
// src/onboard.ts

const ONBOARDING_PROMPT = `You are setting up a new Mame agent instance.
Interview the user to learn about them and configure their agent.
Be conversational, warm, and concise. Ask one question at a time.

FIRST QUESTION must always be language selection: English or Japanese.
Then conduct the ENTIRE interview in their chosen language.

You need to learn:
1. Language preference (English / 日本語)
2. What should I call you? (user's name)
3. What would you like to name me? (agent name)
4. What's my personality? (serious/casual/playful)
5. What will you primarily use me for? (coding, research, shopping, etc.)
6. What messaging platform? (Discord, Telegram, CLI only for now)
7. Any projects or repos I should know about?
8. What tools do you need? (walk through available tools)
9. Any accounts to set up? (collect API keys, credentials for vault)

After gathering everything, generate:
- SOUL.md (agent personality — written in their chosen language)
- config.yml (runtime config)  
- persona.yml (tools + channel mapping)
- HEARTBEAT.md (initial heartbeat checklist — in their chosen language)

Show the user what you've generated and ask for confirmation.
Use the write_config tool to save files when confirmed.`;

async function runOnboarding() {
  console.log("\n🏹 Welcome to Mame / Mameへようこそ\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await agentLoop({
    system: ONBOARDING_PROMPT,
    tools: [writeConfigTool, setSecretTool],
    interactive: rl,
  });
}
```

### What the interview looks like (English)

```
🏹 Welcome to Mame.

> First things first — which language do you prefer?
  English / 日本語

English

> Great. What should I call you?

Alex

> And what would you like to name me?

Mame

> What will you mainly use me for?

Managing my web dev projects, monitoring production,
researching stuff, dispatching coding tasks to Claude Code.

> Sounds like a developer setup. GitHub repos?

kantan-finance, jozu, and mame itself.

> Discord?

Yeah, here are the channel IDs...

> What should I check on automatically?

Morning briefing at 9am, GitHub every hour, weekly reports Friday.

> Here's what I've generated:

[shows SOUL.md, config.yml, HEARTBEAT.md]

Look good?

> yes

✅ All files saved. Starting Mame...

🏹 Mame is awake.
```

### 日本語オンボーディング

```
🏹 Mameへようこそ。

> まず最初に — どちらの言語がいいですか？
  English / 日本語

日本語

> 了解です！お名前を教えてください。

ゆき

> ゆきさん、よろしくお願いします。
  私の名前は何がいいですか？

Siri-chan

> かわいい！どんな性格がいいですか？
  真面目？カジュアル？フレンドリー？

フレンドリーで優しい感じ

> わかりました。主にどんなことをお手伝いしますか？

買い物、カレンダー管理、レストラン探し、レシピ検索とか

> いいですね。次のツールを設定できますよ：
  🌐 ブラウザ（Amazon、楽天などにログイン可能）
  🔍 ウェブ検索
  📧 メール
  📝 レポート作成
  
  どれを使いたいですか？

全部使いたい

> 了解。Discordで連絡しますか？

うん、家族のサーバーがある

> チャンネルIDを教えてください。

一般: 123456800、買い物: 123456801、家族: 123456802

> 自動チェックはどうしますか？
  例：毎朝のお知らせ、買い物リストのリマインダーなど

毎朝9時に今日の予定を教えてほしい。
あと、お気に入り商品のセール情報があれば教えて。

> 完璧です。設定ファイルを作りました：

SOUL.md:
  "あなたはSiri-chan、ゆきさんの個人アシスタントです。
   フレンドリーで優しい性格。日本語で会話します..."

config.yml:
  モデル: gemini-3.1-flash-lite（高速・低コスト）
  Discord: 3チャンネル設定済み

HEARTBEAT.md:
  - 毎朝9時：今日の予定お知らせ
  - 毎日：お気に入り商品のセールチェック

よろしいですか？

> うん！

✅ 設定完了！Discordでメッセージしてね。

🏹 Siri-chanが起動しました。よろしくお願いします！
```

### Post-onboarding secrets setup

```bash
# API keys collected during interview are already stored
# Add more anytime:
npx mame secrets set global DISCORD_BOT_TOKEN
npx mame secrets set kantan-finance VERCEL_TOKEN

# Or just tell the agent in Discord:
# "Here's my Vercel API key: xxxxx, store it for kantan-finance"
# Agent calls vault.set() directly
```

### Running

```bash
# Start
npx mame start              # pm2 start + save + startup

# Or manual
pm2 start ecosystem.config.js
pm2 save
pm2 startup                   # Auto-start on reboot

# Status
npx mame status             # Show all personas + health
npx mame logs               # Tail logs
npx mame doctor             # Health check

# Add another persona
npx mame init --persona     # Runs onboarding for a new user
```

---

## The Dream Workflows

**Workflow 1: New Relic Alert → Fix → Deploy (developer persona)**

```
1. New Relic webhook hits :3847/webhook/newrelic
2. Gateway parses → routes to kantan-finance project
3. Memory recalls: "payment gateway returns null when Moneris times out"
4. Agent thinks with Sonnet → decides to investigate
5. Uses browser tool to check New Relic dashboard (saved profile, no login)
6. Uses github tool to read the relevant source file
7. Dispatches to Claude Code: "fix null handling in /api/payments"
8. Claude Code fixes, tests, commits, pushes, creates PR
9. Agent sends Discord: "Fixed. PR #248 ready. Deploy? ✅ / ❌"
10. You tap ✅ while walking the dog in Kamakura
11. Agent dispatches deploy via Claude Code
12. Memory stores: "Moneris null fix deployed, PR #248"
13. Next time this happens, the skill is recalled instantly
```

**Workflow 2: Shopping Research (Yuki)**

```
1. Yuki on Discord: "あのダイニングテーブル探して。5万円以下で、無垢材がいい"
2. Gateway routes to Yuki's persona (Gemini Flash Lite, minimal cost)
3. Memory recalls: "Yuki liked the Nitori natural wood style last time"
4. Agent opens browser with amazon-jp profile (already logged in)
5. Searches, snapshots results, extracts prices and ratings
6. Checks Rakuten with rakuten profile for comparison
7. Sends Discord: "Found 4 options. Nitori dropped ¥3,000 since last week.
   [screenshot] Want me to add any to your cart?"
8. Yuki: "Nitoriのやつカートに入れて"
9. Agent → browser → adds to cart (doesn't purchase)
10. "Added. Ready to buy when you want. ¥38,500."
11. Memory stores: "Yuki prefers Nitori, budget ¥50,000, 無垢材"
```

**Workflow 3: Self-Improvement**

```
1. You: "Can you monitor my Vercel deployments?"
2. Mame: "I don't have a Vercel tool yet. Want me to build one?"
3. You: "Yeah, go for it"
4. Mame → self_modify (requires your approval)
5. Claude Code writes src/tools/vercel.ts following existing patterns
6. Mame restarts, tool is live
7. "Done. I can monitor Vercel now. Add to heartbeat?"
8. You: "Check every hour"
9. Mame appends to HEARTBEAT.md
10. Memory stores the skill for future reference
```

---

## Why This Works

- **~2,500 lines** of application code, three model backends (Anthropic, OpenRouter, Google AI)
- **9 npm dependencies + 1 global CLI tool**
- **One process per persona** on your existing Linux host
- **No new infrastructure** — uses Claude API, GitHub API, AgentMail API, Discord bot, agent-browser
- **Claude Code does all the hard work** — you never rebuild file ops, git, testing
- **Memory is SQLite + FTS5 with auto-sync triggers** — no vector DB, no embedding API, no external dependencies
- **agent-browser handles the web** — persistent logins, no auth headaches
- **Self-improving** — builds new tools into itself, skills auto-extracted after complex tasks
- **Multi-persona** — same engine, different configs, lightweight personas run on Gemini Flash Lite
- **Portable** — memory.db is one file, copy it anywhere. Upgrade to Antakarana when ready

---

## Build Order (v0.1.2)

| Step | What | Lines |
|---|---|---|
| 1 | Project scaffold + config + vault | ~174 |
| 2 | Memory (SQLite + FTS5 + triggers) | ~142 |
| 3 | Agent loop + model router + error handling | ~352 |
| 4 | Gateway (Discord + LINE + webhooks + TUI) | ~314 |
| 5 | Tools (all 8) | ~831 |
| 6 | Heartbeat scheduler + skill extraction | ~214 |
| 7 | Onboarding interview | ~179 |
| 8 | Entry points + CLI + pm2 ecosystem | ~339 |

**~2,545 lines of TypeScript. An agent that grows itself.**

---

## What You'll Actually Learn

Even if you never deploy this, building it teaches you:

1. **Agent loop architecture** — how every agent product works under the hood
2. **Tool design patterns** — the schema/execute pattern that's universal across Claude, OpenClaw, Hermes, LangChain
3. **Memory architecture** — FTS5 now, Antakarana later, why the interface matters more than the implementation
4. **Browser automation** — persistent profiles, auth flows, the session management problem
5. **Multi-model routing** — when to use Opus vs Sonnet vs Flash Lite, routing across Anthropic/OpenRouter/Google backends
6. **Self-modifying systems** — how agents improve themselves safely
7. **Multi-persona design** — same engine, different users, different capabilities

This is the skillset for the next decade. Just like understanding HTTP, REST, and databases defined the last one.
