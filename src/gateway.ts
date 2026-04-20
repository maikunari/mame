// src/gateway.ts — Discord + LINE + Signal + webhooks + TUI

import { Client, GatewayIntentBits, type TextChannel } from "discord.js";
import { messagingApi, middleware } from "@line/bot-sdk";
import express from "express";
import fs from "fs";
import path from "path";
import readline from "readline";
import { think, type Turn } from "./agent.js";
import { type MameConfig, type PersonaConfig, MAME_HOME } from "./config.js";
import { SignalClient, type SignalMessage } from "./signal.js";
import { runSignalOnboarding } from "./onboard.js";
import { Vault } from "./vault.js";
import { recall, listMemories, memoryStats } from "./memory.js";
import { childLogger } from "./logger.js";
import { provideAnswer, hasPendingQuestion } from "./ask-human-state.js";
import {
  exchangeCodeForTokens,
  storeTokens,
  readPendingAuth,
  clearPendingAuth,
} from "./x-auth.js";
import { listRenderedIssues } from "./magazine/render.js";
import { PUBLIC_DIR } from "./magazine/state.js";

const log = childLogger("gateway");

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
  private signal: SignalClient | null = null;
  private webhookServer: express.Application;
  private config: MameConfig;
  private persona: PersonaConfig;
  private vault: Vault;
  // Channels currently in "think deep" sticky mode (complex model)
  private complexModeChannels = new Set<string>();
  // Per-channel thinking level override (persists until changed or restart)
  private thinkingOverrides = new Map<string, "off" | "low" | "medium" | "high">();

  constructor(config: MameConfig, persona: PersonaConfig, vault: Vault) {
    this.config = config;
    this.persona = persona;
    this.vault = vault;
    this.webhookServer = express();
    this.webhookServer.use(express.json({ limit: "100kb" })); // Limit request body size
  }

  async start(): Promise<void> {
    if (this.config.discord?.enabled && this.persona.discord) {
      await this.startDiscord();
    }
    if (this.config.line?.enabled && this.persona.line) {
      await this.startLINE();
    }
    if (this.config.signal?.enabled && this.persona.signal) {
      await this.startSignal();
    }
    await this.startWebhooks();
    this.startTUI();
    // Note: "Mame is awake" log is emitted by index.ts after heartbeat.start()
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

      // Evening 6: if a child agent (Claude Code) is currently waiting
      // for an answer to a question it asked via ask_human, route this
      // message as the answer INSTEAD of running it through think().
      // The child agent's MCP tool call will resolve, its execution
      // continues, and the user gets a one-line acknowledgement so
      // they know the message went to the subprocess, not to Mame.
      if (hasPendingQuestion("discord", msg.channelId)) {
        const delivered = provideAnswer("discord", msg.channelId, msg.content);
        if (delivered) {
          await msg.channel.send(
            "📨 Forwarded your answer to the running task. I'll let you know when it's done."
          );
          return;
        }
      }

      // Capture image attachments
      const imageUrls = msg.attachments
        .filter((a) => a.contentType?.startsWith("image/"))
        .map((a) => a.url);

      // Download text file attachments and inline their content
      const textAttachments = msg.attachments.filter(
        (a) =>
          a.contentType?.startsWith("text/") ||
          a.name?.endsWith(".txt") ||
          a.name?.endsWith(".md") ||
          a.name?.endsWith(".csv") ||
          a.name?.endsWith(".json") ||
          a.name?.endsWith(".yml") ||
          a.name?.endsWith(".yaml") ||
          a.name?.endsWith(".xml") ||
          a.name?.endsWith(".log") ||
          a.name?.endsWith(".ts") ||
          a.name?.endsWith(".js") ||
          a.name?.endsWith(".py") ||
          a.name?.endsWith(".sh")
      );

      let messageText = msg.content;
      for (const att of textAttachments.values()) {
        try {
          const res = await fetch(att.url);
          if (res.ok) {
            const text = await res.text();
            // Cap at 50KB to avoid flooding context
            const truncated =
              text.length > 50_000
                ? text.slice(0, 50_000) + "\n... (truncated, file was " + text.length + " chars)"
                : text;
            messageText += `\n\n--- Attached file: ${att.name} ---\n${truncated}\n--- End of ${att.name} ---`;
          }
        } catch (err) {
          log.warn({ file: att.name, err: String(err) }, "Failed to download text attachment");
        }
      }

      // Show typing indicator while thinking (refreshes every 8s, Discord typing lasts 10s)
      await msg.channel.sendTyping();
      const typingInterval = setInterval(() => {
        msg.channel.sendTyping().catch(() => {});
      }, 8000);

      try {
        // Model mode switching: "think deep" / "think normal"
        // Sticky per-channel — stays on complex until explicitly switched back
        const thinkDeepToggle = /^think\s+deep\s*$/i;
        const thinkDeepInline = /^think\s+deep\s*:\s*/i;
        const thinkNormal = /^think\s+(normal|fast|default)\s*$/i;

        if (thinkNormal.test(messageText.trim())) {
          this.complexModeChannels.delete(msg.channelId);
          log.info({ channel: msg.channelId }, "Switched back to default model");
          await msg.channel.send("⚡ Back to default model.");
          clearInterval(typingInterval);
          return;
        }

        if (thinkDeepToggle.test(messageText.trim()) && this.persona.models.complex) {
          this.complexModeChannels.add(msg.channelId);
          log.info({ channel: msg.channelId, model: this.persona.models.complex }, "Switched to complex model (sticky)");
          await msg.channel.send(`🧠 Switched to complex model. All messages in this channel use \`${this.persona.models.complex}\` until you say "think normal".`);
          clearInterval(typingInterval);
          return;
        }

        // "think deep: <message>" — one-shot, also activates sticky mode
        if (thinkDeepInline.test(messageText) && this.persona.models.complex) {
          messageText = messageText.replace(thinkDeepInline, "");
          this.complexModeChannels.add(msg.channelId);
          log.info({ channel: msg.channelId, model: this.persona.models.complex }, "Switched to complex model (sticky, inline)");
        }

        // Reasoning toggle: "reasoning on/off/low/medium/high"
        const reasoningMatch = messageText.trim().match(/^reasoning\s+(on|off|low|medium|high)\s*$/i);
        if (reasoningMatch) {
          const level = reasoningMatch[1].toLowerCase();
          if (level === "off") {
            this.thinkingOverrides.set(msg.channelId, "off");
            await msg.channel.send("🚫 Reasoning disabled. Faster & cheaper responses, but may be less thoughtful.");
          } else {
            const mapped = (level === "on" ? "medium" : level) as "low" | "medium" | "high";
            this.thinkingOverrides.set(msg.channelId, mapped);
            await msg.channel.send(`🧠 Reasoning set to **${mapped}**. Will think before responding.`);
          }
          log.info({ channel: msg.channelId, level }, "Reasoning level changed");
          clearInterval(typingInterval);
          return;
        }

        // Resolve model: sticky complex mode > default
        const modelOverride = this.complexModeChannels.has(msg.channelId)
          ? this.persona.models.complex
          : undefined;
        const thinkingOverride = this.thinkingOverrides.get(msg.channelId);

        const turn = this.buildTurn(messageText, "discord", project, modelOverride, thinkingOverride);
        if (imageUrls.length > 0) turn.imageUrls = imageUrls;
        const reply = await think(turn);

        for (const chunk of splitMessage(reply, 2000)) {
          await msg.channel.send(chunk);
        }
      } finally {
        clearInterval(typingInterval);
      }
    });

    const token = await this.vault.get("global", "DISCORD_BOT_TOKEN");
    if (!token) {
      log.error("DISCORD_BOT_TOKEN not found in vault — Discord will not start");
      return;
    }
    await this.discord.login(token);
    log.info({ user: this.discord.user?.tag }, `Discord connected as ${this.discord.user?.tag}`);
  }

  // --- LINE (acknowledge-then-push pattern) ---
  private async startLINE(): Promise<void> {
    const channelAccessToken = await this.vault.get("global", "LINE_CHANNEL_ACCESS_TOKEN");
    const channelSecret = await this.vault.get("global", "LINE_CHANNEL_SECRET");

    if (!channelAccessToken || !channelSecret) {
      log.error("LINE credentials not found in vault — LINE will not start");
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

    log.info("LINE webhook registered at /line/webhook");
  }

  // --- Signal ---
  private onboardingSessions = new Set<string>(); // Track active onboarding conversations

  private async startSignal(): Promise<void> {
    const signalNumber = this.config.signal!.number;
    this.signal = new SignalClient(signalNumber);

    // Queue for receiving messages during onboarding (per-user)
    const messageQueues = new Map<string, ((text: string) => void)[]>();

    this.signal.on("message", async (msg: SignalMessage) => {
      // Skip group messages
      if (msg.groupId) return;

      // If this user is in an active onboarding session, route to the queue
      if (this.onboardingSessions.has(msg.sender)) {
        const queue = messageQueues.get(msg.sender);
        if (queue && queue.length > 0) {
          const resolve = queue.shift()!;
          resolve(msg.text);
        }
        return;
      }

      // Check if this is a known/mapped user
      const userNumbers = this.persona.signal?.userNumbers || [];
      const isKnownUser = userNumbers.includes(msg.sender);
      const globalUserMap = this.config.signal?.userMap || {};
      const isMappedUser = msg.sender in globalUserMap;

      if (!isKnownUser && !isMappedUser) {
        // Unknown user — start onboarding
        log.info({ sender: msg.sender }, "Unknown Signal user — starting onboarding");
        this.onboardingSessions.add(msg.sender);
        messageQueues.set(msg.sender, []);

        const sendFn = async (text: string) => {
          for (const chunk of splitMessage(text, 5000)) {
            await this.signal!.send(msg.sender, chunk);
          }
        };

        const receiveFn = (): Promise<string> => {
          return new Promise((resolve) => {
            const queue = messageQueues.get(msg.sender)!;
            queue.push(resolve);
          });
        };

        try {
          const model = process.env.MAME_ONBOARD_MODEL || "google/gemini-3.1-flash-lite-preview";
          await runSignalOnboarding(
            model,
            msg.sender,
            msg.text,
            signalNumber,
            sendFn,
            receiveFn,
          );
          log.info({ sender: msg.sender }, "Signal onboarding complete");

          // Notify admin to restart for new persona to take effect
          await this.notify(undefined, `🫘 New persona onboarded via Signal: ${msg.sender}. Restart to activate: pm2 restart all`);
        } catch (err) {
          log.error({ sender: msg.sender, err: String(err) }, "Signal onboarding failed");
          await this.signal!.send(msg.sender, "Sorry, something went wrong during setup. Please try again.");
        } finally {
          this.onboardingSessions.delete(msg.sender);
          messageQueues.delete(msg.sender);
        }
        return;
      }

      // Known user — normal conversation
      const project = globalUserMap[msg.sender] || undefined;

      const reply = await think(this.buildTurn(msg.text, "signal", project));

      for (const chunk of splitMessage(reply, 5000)) {
        await this.signal!.send(msg.sender, chunk);
      }
    });

    await this.signal.start();
    log.info({ number: signalNumber }, `Signal connected as ${signalNumber}`);
  }

  // --- Webhooks (New Relic, GitHub, AgentMail) ---
  private async startWebhooks(): Promise<void> {
    this.webhookServer.get("/health", (_req, res) => {
      res.json({ status: "ok", persona: this.persona.name, uptime: process.uptime() });
    });

    // X OAuth 2.0 PKCE callback — browser lands here after user approves on twitter.com
    this.webhookServer.get("/x/callback", async (req, res) => {
      const { code, state, error } = req.query;

      if (error) {
        res.status(400).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h2>❌ Auth denied</h2><p>${error}</p></body></html>`);
        return;
      }

      const pending = readPendingAuth();
      if (!pending) {
        res.status(400).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h2>❌ No pending auth session</h2><p>Run <code>mame x auth</code> first.</p></body></html>`);
        return;
      }

      if (state !== pending.state) {
        res.status(400).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h2>❌ State mismatch</h2><p>Possible CSRF. Run <code>mame x auth</code> again.</p></body></html>`);
        clearPendingAuth();
        return;
      }

      try {
        const clientId = await this.vault.get("global", "X_CLIENT_ID");
        const clientSecret = await this.vault.get("global", "X_CLIENT_SECRET");
        if (!clientId || !clientSecret) {
          res.status(500).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h2>❌ Missing credentials</h2><p>X_CLIENT_ID or X_CLIENT_SECRET not in vault.</p></body></html>`);
          return;
        }

        const tokens = await exchangeCodeForTokens(
          code as string,
          pending.verifier,
          clientId,
          clientSecret
        );
        await storeTokens(this.vault, tokens);
        clearPendingAuth();
        log.info("X OAuth 2.0 complete — tokens stored in vault");

        res.send(`<!DOCTYPE html><html>
<head><title>X Auth Complete</title></head>
<body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center">
  <h1>✅ Connected to X</h1>
  <p>Mame can now access your bookmarks.</p>
  <p style="color:#666">You can close this tab.</p>
</body></html>`);
      } catch (err) {
        log.error({ err: String(err) }, "X callback: token exchange failed");
        res.status(500).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h2>❌ Token exchange failed</h2><p>${String(err)}</p></body></html>`);
      }
    });

    // Magazine — index listing + static HTML files
    // Index route must be registered before express.static so Express doesn't
    // look for a missing PUBLIC_DIR/index.html and fall through to 404.
    this.webhookServer.get("/magazine", (_req, res) => {
      res.redirect(301, "/magazine/");
    });

    this.webhookServer.get("/magazine/", (_req, res) => {
      const issues = listRenderedIssues();
      if (issues.length === 0) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(
          `<html><body style="font-family:sans-serif;max-width:50rem;margin:4rem auto;padding:0 1.5rem">` +
          `<h2>No issues rendered yet</h2>` +
          `<p>Run <code>mame magazine render</code> to render an issue.</p>` +
          `</body></html>`
        );
        return;
      }
      const rows = issues
        .map(
          (iss) =>
            `<tr>` +
            `<td><a href="/magazine/${iss.date}.html">#${iss.issueNumber ?? "—"}</a></td>` +
            `<td>${iss.date}</td>` +
            `<td>${iss.signal ? iss.signal.replace(/&/g, "&amp;").replace(/</g, "&lt;") : "—"}</td>` +
            `<td style="text-align:right">${iss.savedToday ?? "—"}</td>` +
            `</tr>`
        )
        .join("\n");
      const html =
        `<!doctype html><html lang="en"><head>` +
        `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>dAIly digest — issues</title>` +
        `<style>` +
        `body{font-family:system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1.5rem;color:#222;background:#faf8f3}` +
        `h1{font-size:1.75rem;margin-bottom:0.25rem}` +
        `p{color:#666;margin-bottom:2rem;font-size:0.9rem}` +
        `table{width:100%;border-collapse:collapse}` +
        `th,td{padding:0.55rem 0.75rem;text-align:left;border-bottom:1px solid #e5e0d5;vertical-align:top}` +
        `th{font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;color:#999;border-bottom:2px solid #c8bfae}` +
        `a{color:#7a2222;text-decoration:none}a:hover{text-decoration:underline}` +
        `tr:hover td{background:#f2ede2}` +
        `td:nth-child(3){font-style:italic;color:#555;font-size:0.92rem}` +
        `</style></head><body>` +
        `<h1>d<span style="color:#7a2222;font-style:italic">AI</span>ly digest</h1>` +
        `<p>${issues.length} issue${issues.length !== 1 ? "s" : ""} · <a href="/magazine/latest.html">latest →</a></p>` +
        `<table><thead><tr><th>#</th><th>Date</th><th>Signal</th><th style="text-align:right">Items</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>` +
        `</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    });

    this.webhookServer.use("/magazine", express.static(PUBLIC_DIR));

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
    const host = process.env.MAME_BIND_HOST || "0.0.0.0";
    this.webhookServer.listen(port, host, () => {
      log.info({ host, port }, `Webhook server listening on ${host}:${port}`);
    }).on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.warn({ host, port }, `Webhook port ${port} already in use — skipping (another persona likely owns it)`);
      } else {
        throw err;
      }
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
          signal: !!this.signal,
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
          log.error({ err: String(err) }, "Discord notify failed");
        }
      }
    }

    // Fallback to Signal
    if (this.signal && this.config.signal?.userMap) {
      // Send to the first mapped user
      const firstUser = Object.keys(this.config.signal.userMap)[0];
      if (firstUser) {
        for (const chunk of splitMessage(message, 5000)) {
          await this.signal.send(firstUser, chunk);
        }
        return;
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
    project?: string,
    modelOverride?: string,
    thinkingOverride?: Turn["thinkingLevel"]
  ): Turn {
    return {
      message,
      channel,
      project: project || undefined,
      personaId: this.persona.name,
      soulFile: this.persona.soul,
      model: modelOverride || this.persona.models.default,
      tools: this.persona.tools,
      thinkingLevel: thinkingOverride || this.persona.thinkingLevel,
    };
  }
}
