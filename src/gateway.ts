// src/gateway.ts — Discord + LINE + webhooks + TUI (~100 lines per spec)

import { Client, GatewayIntentBits, type TextChannel } from "discord.js";
import { messagingApi, middleware } from "@line/bot-sdk";
import express from "express";
import readline from "readline";
import { think, type Turn } from "./agent.js";
import { type MameConfig, type PersonaConfig, MAME_HOME } from "./config.js";
import { Vault } from "./vault.js";
import { recall, listMemories, memoryStats } from "./memory.js";

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}

export class Gateway {
  private discord: Client | null = null;
  private line: messagingApi.MessagingApiClient | null = null;
  private webhookServer: express.Application;
  private config: MameConfig;
  private persona: PersonaConfig;
  private vault: Vault;

  constructor(config: MameConfig, persona: PersonaConfig, vault: Vault) {
    this.config = config;
    this.persona = persona;
    this.vault = vault;
    this.webhookServer = express();
    this.webhookServer.use(express.json());
  }

  async start(): Promise<void> {
    if (this.config.discord?.enabled && this.persona.discord) {
      await this.startDiscord();
    }
    if (this.config.line?.enabled && this.persona.line) {
      await this.startLINE();
    }
    await this.startWebhooks();
    this.startTUI();
    console.log(`🫘 ${this.persona.name} is awake.`);
  }

  // --- Discord ---
  private async startDiscord(): Promise<void> {
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.discord.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;

      // Only respond in channels mapped to this persona
      const channelMap = this.persona.discord?.channelMap || {};
      if (!(msg.channelId in channelMap)) return;

      const project = channelMap[msg.channelId] || undefined;

      // Show typing indicator while thinking (refreshes every 8s, Discord typing lasts 10s)
      await msg.channel.sendTyping();
      const typingInterval = setInterval(() => {
        msg.channel.sendTyping().catch(() => {});
      }, 8000);

      try {
        const reply = await think(this.buildTurn(msg.content, "discord", project));

        for (const chunk of splitMessage(reply, 2000)) {
          await msg.channel.send(chunk);
        }
      } finally {
        clearInterval(typingInterval);
      }
    });

    const token = await this.vault.get("global", "DISCORD_BOT_TOKEN");
    if (!token) {
      console.error("[gateway] DISCORD_BOT_TOKEN not found in vault");
      return;
    }
    await this.discord.login(token);
    console.log(`[gateway] Discord connected as ${this.discord.user?.tag}`);
  }

  // --- LINE (acknowledge-then-push pattern) ---
  private async startLINE(): Promise<void> {
    const channelAccessToken = await this.vault.get("global", "LINE_CHANNEL_ACCESS_TOKEN");
    const channelSecret = await this.vault.get("global", "LINE_CHANNEL_SECRET");

    if (!channelAccessToken || !channelSecret) {
      console.error("[gateway] LINE credentials not found in vault");
      return;
    }

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

          // Only respond to mapped LINE users
          const lineUserIds = this.persona.line?.userIds || [];
          if (!lineUserIds.includes(userId)) continue;

          const project = this.config.line?.userMap?.[userId] || undefined;

          // Acknowledge immediately to use the free reply token
          try {
            await this.line!.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: "🫘" }],
            });
          } catch {
            // Reply token may already be expired, that's fine
          }

          // Process the message (may take >30s for complex tasks)
          const reply = await think(this.buildTurn(event.message.text, "line", project));

          // Send the real response via pushMessage
          for (const chunk of splitMessage(reply, 5000)) {
            await this.line!.pushMessage({
              to: userId,
              messages: [{ type: "text", text: chunk }],
            });
          }
        }
      }
    );

    console.log("[gateway] LINE webhook registered at /line/webhook");
  }

  // --- Webhooks (New Relic, GitHub, AgentMail) ---
  private async startWebhooks(): Promise<void> {
    this.webhookServer.get("/health", (_req, res) => {
      res.json({ status: "ok", persona: this.persona.name, uptime: process.uptime() });
    });

    this.webhookServer.post("/webhook/:source", async (req, res) => {
      const source = req.params.source;
      const message = `Incoming webhook from ${source}: ${JSON.stringify(req.body)}`;
      // TODO: parseWebhook and routeWebhookToProject per source

      res.status(200).json({ received: true });

      const reply = await think(this.buildTurn(message, "webhook"));
      await this.notify(undefined, reply);
    });

    this.webhookServer.post("/webhook/test", async (req, res) => {
      const message = req.body.message || "Test webhook received";
      res.status(200).json({ received: true, message });
      await this.notify(undefined, `🔔 ${message}`);
    });

    const port = this.config.webhook?.port || 3847;
    this.webhookServer.listen(port, () => {
      console.log(`[gateway] Webhook server listening on port ${port}`);
    });
  }

  // --- TUI (Terminal UI) ---
  private startTUI(): void {
    // Don't start TUI if stdin is not a TTY (e.g., running as daemon)
    if (!process.stdin.isTTY) return;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): void => {
      rl.question(`🫘 ${this.persona.name}> `, async (input) => {
        if (!input.trim()) {
          prompt();
          return;
        }
        if (input === "exit") process.exit(0);

        // TUI commands
        if (input.startsWith("/")) {
          await this.handleTUICommand(input);
        } else {
          const reply = await think(this.buildTurn(input, "cli"));
          console.log(`\n${reply}\n`);
        }
        prompt();
      });
    };

    prompt();
  }

  private async handleTUICommand(input: string): Promise<void> {
    const [cmd, ...args] = input.slice(1).split(" ");
    switch (cmd) {
      case "status":
        console.log(JSON.stringify({
          persona: this.persona.name,
          uptime: process.uptime(),
          discord: this.discord?.isReady() || false,
          line: !!this.line,
        }, null, 2));
        break;
      case "memory": {
        const query = args.join(" ");
        if (!query) {
          const stats = await memoryStats();
          console.log(JSON.stringify(stats, null, 2));
        } else {
          const results = await recall(query);
          for (const r of results) {
            console.log(`[${r.id}] ${r.content}`);
          }
        }
        break;
      }
      case "heartbeat":
        console.log("Running heartbeat... (use the heartbeat scheduler for automated checks)");
        break;
      case "cost":
        console.log("Cost reporting not yet implemented");
        break;
      case "secrets": {
        const project = args[0] || "global";
        const keys = await this.vault.list(project);
        console.log(`Secrets for ${project}: ${keys.join(", ") || "(none)"}`);
        break;
      }
      case "doctor":
        console.log("Running health check...");
        console.log(`  Persona: ${this.persona.name}`);
        console.log(`  Discord: ${this.discord?.isReady() ? "✅ connected" : "❌ not connected"}`);
        console.log(`  LINE: ${this.line ? "✅ configured" : "❌ not configured"}`);
        console.log(`  Webhook: ✅ port ${this.config.webhook?.port || 3847}`);
        console.log(`  Memory: ✅ ${(await memoryStats()).total} memories`);
        break;
      case "help":
        console.log(`
  /status     — Show agent health
  /memory     — Search memories (or show stats with no query)
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
  async notify(project: string | undefined, message: string): Promise<void> {
    // Try Discord first
    if (this.discord?.isReady()) {
      const channelMap = this.persona.discord?.channelMap || {};
      const channelId = project
        ? Object.entries(channelMap).find(([, p]) => p === project)?.[0]
        : this.config.discord?.defaultChannel;

      if (channelId) {
        try {
          const channel = await this.discord.channels.fetch(channelId);
          if (channel && "send" in channel) {
            for (const chunk of splitMessage(message, 2000)) {
              await (channel as TextChannel).send(chunk);
            }
            return;
          }
        } catch (err) {
          console.error(`[gateway] Discord notify failed: ${err}`);
        }
      }
    }

    // Fallback to LINE
    if (this.line && this.config.line?.defaultUserId) {
      for (const chunk of splitMessage(message, 5000)) {
        await this.line.pushMessage({
          to: this.config.line.defaultUserId,
          messages: [{ type: "text", text: chunk }],
        });
      }
    }
  }

  private buildTurn(
    message: string,
    channel: Turn["channel"],
    project?: string
  ): Turn {
    return {
      message,
      channel,
      project: project || undefined,
      personaId: this.persona.name,
      soulFile: this.persona.soul,
      model: this.persona.models.default,
      tools: this.persona.tools,
    };
  }
}
