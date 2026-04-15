// src/index.ts — Main entry point for the Mame daemon

import { loadConfig, loadPersona } from "./config.js";
import { Gateway } from "./gateway.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { Vault } from "./vault.js";
import { loadTools } from "./tools/index.js";
import { loadSystemdCredentials } from "./init-credentials.js";
import { childLogger } from "./logger.js";
import { startMcpServer } from "./mcp-server.js";
import { backfillEmbeddings, remember } from "./memory.js";
import { warmUpEmbedding } from "./embedding.js";
import { getActiveConversations } from "./agent.js";

const log = childLogger("daemon");

async function main(): Promise<void> {
  // Load systemd credentials FIRST so MAME_MASTER_KEY is in process.env
  // before anything constructs the Vault. No-op if $CREDENTIALS_DIRECTORY
  // isn't set (i.e. when running under pm2 or directly from a shell that
  // already has the env vars).
  const credResult = loadSystemdCredentials();
  if (credResult.source === "systemd" && credResult.loaded.length > 0) {
    log.info(
      { count: credResult.loaded.length, credentials: credResult.loaded },
      `Loaded ${credResult.loaded.length} credential(s) from systemd`
    );
  }

  // Load all tool registrations before anything else
  await loadTools();

  // Parse --persona flag
  const personaArg = process.argv.find((a) => a.startsWith("--persona"));
  let personaName: string;

  if (personaArg) {
    const idx = process.argv.indexOf(personaArg);
    personaName = personaArg.includes("=")
      ? personaArg.split("=")[1]
      : process.argv[idx + 1];
  } else {
    personaName = process.env.MAME_PERSONA || "default";
  }

  log.info({ persona: personaName }, "Starting Mame daemon");

  // Load configuration
  const config = loadConfig();
  const persona = loadPersona(personaName);
  const vault = new Vault();

  // Load secrets into environment for tools that need them
  const globalSecrets = await vault.getAll("global");
  for (const [key, value] of Object.entries(globalSecrets)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  // Load project-specific secrets
  for (const projectName of Object.keys(config.projects)) {
    const projectSecrets = await vault.getAll(projectName);
    for (const [key, value] of Object.entries(projectSecrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  log.info(
    {
      globalSecretCount: Object.keys(globalSecrets).length,
      projects: Object.keys(config.projects),
    },
    "Loaded vault secrets"
  );

  // Warm up the embedding model and backfill any memories missing a
  // vector. This happens in the background so gateway/heartbeat start
  // without waiting — the first embed() call blocks on the same promise
  // so the model is guaranteed ready before any real memory op.
  void (async () => {
    try {
      await warmUpEmbedding();
      const result = await backfillEmbeddings();
      if (result.backfilled > 0) {
        log.info({ backfilled: result.backfilled }, "Embedding backfill complete");
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Embedding warmup/backfill failed — recall will fall back to FTS5-only"
      );
    }
  })();

  // Start gateway (Discord, webhooks, TUI, Signal)
  const gateway = new Gateway(config, persona, vault);
  await gateway.start();

  // Start the embedded MCP server on localhost:3848. The ask_human tool
  // routes questions from child agents (Claude Code) back to the user
  // via gateway.notify(). The callback closes over the gateway
  // instance here so mcp-server.ts stays free of gateway-specific
  // imports — one-way dependency only.
  try {
    await startMcpServer({
      onQuestion: async (task, question) => {
        // Format the question with the child agent's task description
        // as context so the user knows which dispatched task is asking.
        const prefix = task.description
          ? `❓ **Question from running task** (_${task.description}_):\n\n`
          : `❓ **Question from running task:**\n\n`;
        const body =
          prefix +
          question +
          `\n\n*Reply in this channel to answer. 10-minute timeout.*`;
        // Route to the channel that dispatched the task. For v1 we use
        // gateway.notify with undefined project which goes to the
        // default channel — good enough when there's one Discord
        // channel per persona. TODO: plumb full channelId through from
        // the Turn for multi-channel personas.
        await gateway.notify(undefined, body);
      },
    });
  } catch (err) {
    // MCP server failure is not fatal — heartbeats and chat keep
    // working, only the Claude Code ask_human flow is unavailable.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "MCP server failed to start — Claude Code ask_human unavailable this session"
    );
  }

  // Start heartbeat scheduler
  const heartbeat = new HeartbeatScheduler(config, persona, gateway.notify.bind(gateway));
  await heartbeat.start();

  log.info({ persona: personaName }, "🫘 Mame is awake");

  // Graceful shutdown: persist active conversation context to memory
  // so Mame remembers what she was doing after a restart.
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutdown signal received — saving conversation context");

    const conversations = getActiveConversations();
    let saved = 0;

    for (const [key, messages] of conversations) {
      // Skip empty or trivial buffers
      if (messages.length < 2) continue;

      // Extract the last few user/assistant exchanges as a summary
      const recent = messages.slice(-6); // Last ~3 exchanges
      const lines: string[] = [];
      for (const msg of recent) {
        const role = msg.role === "user" ? "User" : "Mame";
        // Extract text content from the message
        let text: string;
        if (typeof msg.content === "string") {
          text = msg.content.slice(0, 500);
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((c: any) => c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text as string)
            .join(" ")
            .slice(0, 500);
        } else {
          continue;
        }
        if (text.trim()) lines.push(`${role}: ${text}`);
      }

      if (lines.length === 0) continue;

      const [, channel, project] = key.split(":");
      const summary =
        `[Auto-saved conversation context before restart — ${channel} channel]\n` +
        lines.join("\n");

      try {
        await remember(
          summary,
          project !== "global" ? project : undefined,
          "conversation-context",
          3 // low importance — ephemeral context, not a key fact
        );
        saved++;
      } catch (err) {
        log.warn({ key, err: String(err) }, "Failed to save conversation context");
      }
    }

    if (saved > 0) {
      log.info({ saved }, `Saved ${saved} conversation context(s) to memory`);
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.fatal({ err: error }, "Fatal error during startup");
  process.exit(1);
});
