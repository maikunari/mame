#!/usr/bin/env node
// src/cli.ts — CLI entry point for `npx mame` commands

import { execSync } from "child_process";
import crypto from "crypto";
import { runOnboarding } from "./onboard.js";
import { MAME_HOME, loadConfig } from "./config.js";
import { Vault } from "./vault.js";
import { recall, listMemories, memoryStats, formatMemoryTimestamp } from "./memory.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { loadTools } from "./tools/index.js";
import { loadSystemdCredentials } from "./init-credentials.js";
import readline from "readline";
import path from "path";
import fs from "fs";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  // Load systemd credentials FIRST so they take precedence over the vault.
  // No-op when $CREDENTIALS_DIRECTORY isn't set (local dev, pm2 deploys),
  // so the existing vault path keeps working unchanged.
  const credResult = loadSystemdCredentials();
  if (credResult.source === "systemd" && credResult.loaded.length > 0) {
    console.log(`[init] Loaded ${credResult.loaded.length} credential(s) from systemd: ${credResult.loaded.join(", ")}`);
  }

  // Load all tool registrations
  await loadTools();
  switch (command) {
    case "init": {
      const isPersona = args.includes("--persona");
      const model = process.env.MAME_ONBOARD_MODEL || "openrouter/qwen/qwen3.5-plus-02-15";
      if (isPersona) {
        console.log("Adding a new persona...\n");
      }
      await runOnboarding(model);
      break;
    }

    case "onboard-signal": {
      const signalNumber = args[1];
      if (!signalNumber || !signalNumber.startsWith("+")) {
        console.log("Usage: mame onboard-signal +PHONE_NUMBER");
        console.log("  The phone number must be registered with signal-cli first.");
        console.log("  Run: bash deploy/install-signal-cli.sh");
        break;
      }

      console.log(`\n🫘 Waiting for a Signal message on ${signalNumber}...`);
      console.log("  Tell the new user to message this number on Signal.");
      console.log("  Press Ctrl+C to cancel.\n");

      const { SignalClient } = await import("./signal.js");
      const { runSignalOnboarding } = await import("./onboard.js");

      const signal = new SignalClient(signalNumber);
      const model = process.env.MAME_ONBOARD_MODEL || "openrouter/qwen/qwen3.5-plus-02-15";

      // Wait for first message from any unknown number
      const messageQueues = new Map<string, ((text: string) => void)[]>();

      signal.on("message", async (msg: any) => {
        if (msg.groupId) return;

        // If already onboarding this user, route to queue
        if (messageQueues.has(msg.sender)) {
          const queue = messageQueues.get(msg.sender)!;
          if (queue.length > 0) {
            const resolve = queue.shift()!;
            resolve(msg.text);
          }
          return;
        }

        console.log(`\n📱 New message from ${msg.sender}: "${msg.text}"`);
        console.log("  Starting onboarding...\n");

        messageQueues.set(msg.sender, []);

        const sendFn = async (text: string) => {
          // Split long messages
          const chunks = text.length <= 5000 ? [text] : [];
          let remaining = text;
          while (remaining.length > 0) {
            if (chunks.length === 0 || remaining.length > 0) {
              chunks.push(remaining.slice(0, 5000));
              remaining = remaining.slice(5000);
            }
          }
          for (const chunk of chunks) {
            await signal.send(msg.sender, chunk);
          }
          // Also log to console so admin can see the conversation
          console.log(`  🫘 → ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
        };

        const receiveFn = (): Promise<string> => {
          return new Promise((resolve) => {
            const queue = messageQueues.get(msg.sender)!;
            queue.push((text: string) => {
              console.log(`  📱 ← ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
              resolve(text);
            });
          });
        };

        try {
          await runSignalOnboarding(model, msg.sender, msg.text, signalNumber, sendFn, receiveFn);
          console.log("\n✅ Onboarding complete!");
          console.log("  Now restart Mame to activate the new persona:");
          console.log("  pm2 restart all\n");
        } catch (err) {
          console.error(`\n❌ Onboarding failed: ${err}`);
          await signal.send(msg.sender, "Sorry, something went wrong during setup. Please try again.");
        }

        messageQueues.delete(msg.sender);
        // Keep listening for more users, or Ctrl+C to exit
      });

      await signal.start();
      // Keep process alive
      await new Promise(() => {});
      break;
    }

    case "start": {
      const ecosystemPath = path.join(process.cwd(), "ecosystem.config.cjs");
      if (!fs.existsSync(ecosystemPath)) {
        console.error("ecosystem.config.cjs not found. Run from the mame project directory.");
        process.exit(1);
      }
      execSync("pm2 start ecosystem.config.cjs", { stdio: "inherit" });
      execSync("pm2 save", { stdio: "inherit" });
      console.log("🫘 Mame started.");
      break;
    }

    case "stop": {
      execSync("pm2 stop all", { stdio: "inherit" });
      console.log("🫘 Mame stopped.");
      break;
    }

    case "restart": {
      execSync("pm2 restart all", { stdio: "inherit" });
      console.log("🫘 Mame restarted.");
      break;
    }

    case "status": {
      try {
        execSync("pm2 status", { stdio: "inherit" });
      } catch {
        console.log("pm2 not running or not installed.");
      }
      break;
    }

    case "logs": {
      const persona = args[1];
      const cmd = persona ? `pm2 logs mame-${persona}` : "pm2 logs";
      execSync(cmd, { stdio: "inherit" });
      break;
    }

    case "chat": {
      const projectFlag = args.indexOf("--project");
      const personaFlag = args.indexOf("--persona");
      const project = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
      const persona = personaFlag >= 0 ? args[personaFlag + 1] : "default";

      // Import dynamically to avoid loading everything for simple commands
      const { loadPersona } = await import("./config.js");
      const { think } = await import("./agent.js");

      const config = loadConfig();
      const personaConfig = loadPersona(persona);

      // Load vault secrets into env so the model router and tools see API
      // keys. Skipped if MAME_MASTER_KEY isn't set — that means secrets are
      // already coming from the systemd-creds loader (or were exported in
      // the calling shell directly), so the vault load isn't needed.
      if (Vault.isAvailable()) {
        const chatVault = new Vault();
        const globalSecrets = await chatVault.getAll("global");
        for (const [key, value] of Object.entries(globalSecrets)) {
          if (!process.env[key]) process.env[key] = value;
        }
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log(`🫘 ${personaConfig.name} — type 'exit' to quit\n`);

      const prompt = (): void => {
        rl.question(`🫘 ${personaConfig.name}> `, async (input) => {
          if (!input.trim()) { prompt(); return; }
          if (input === "exit") { rl.close(); process.exit(0); }

          const reply = await think({
            message: input,
            channel: "cli",
            project,
            personaId: personaConfig.name,
            soulFile: personaConfig.soul,
            model: personaConfig.models.default,
            tools: personaConfig.tools,
          });

          console.log(`\n${reply}\n`);
          prompt();
        });
      };

      prompt();
      return; // Don't exit — keep readline open
    }

    case "heartbeat": {
      const sub = args[1];
      if (sub === "status") {
        const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");
        if (fs.existsSync(heartbeatPath)) {
          console.log(fs.readFileSync(heartbeatPath, "utf-8"));
        } else {
          console.log("No HEARTBEAT.md found.");
        }
      } else if (sub === "run") {
        // Auto-discover persona if not specified
        let persona: string;
        if (args.includes("--persona")) {
          persona = args[args.indexOf("--persona") + 1];
        } else {
          const personasDir = path.join(MAME_HOME, "personas");
          if (fs.existsSync(personasDir)) {
            const files = fs.readdirSync(personasDir).filter((f) => f.endsWith(".yml"));
            if (files.length === 0) {
              console.log("No personas found in ~/.mame/personas/");
              break;
            }
            if (files.length > 1) {
              console.log(`Multiple personas found: ${files.map((f) => f.replace(".yml", "")).join(", ")}`);
              console.log(`Specify one with --persona <name>`);
              break;
            }
            persona = files[0].replace(".yml", "");
            console.log(`Using persona: ${persona}`);
          } else {
            console.log("No ~/.mame/personas/ directory found");
            break;
          }
        }

        const { loadPersona } = await import("./config.js");
        const config = loadConfig();
        const personaConfig = loadPersona(persona);

        // Load vault secrets into env so tools can use them. Skipped when
        // MAME_MASTER_KEY isn't set — secrets are then coming from
        // systemd-creds (post-cutover) or the shell environment.
        if (Vault.isAvailable()) {
          const vault = new Vault();
          const globalSecrets = await vault.getAll("global");
          for (const [key, value] of Object.entries(globalSecrets)) {
            if (!process.env[key]) process.env[key] = value;
          }
        }

        // Use console for notify so we see the output locally
        const scheduler = new HeartbeatScheduler(config, personaConfig, async (_p, msg) => {
          console.log("\n" + "=".repeat(60));
          console.log(msg);
          console.log("=".repeat(60) + "\n");
        });
        const result = await scheduler.runNow();
        console.log(result);
      } else {
        console.log("Usage: mame heartbeat [status|run]");
      }
      break;
    }

    case "memory": {
      const sub = args[1];
      const timezone = loadConfig().timezone || "Asia/Tokyo";
      if (sub === "search") {
        const query = args.slice(2).join(" ");
        if (!query) { console.log("Usage: mame memory search <query>"); break; }
        const results = await recall(query);
        for (const r of results) {
          console.log(
            `[${r.id}] [${r.category}] ${formatMemoryTimestamp(r.created_at, timezone)}\n    ${r.content}`
          );
        }
        if (results.length === 0) console.log("No memories found.");
      } else if (sub === "list") {
        const projectFlag = args.indexOf("--project");
        const project = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
        const results = await listMemories(project);
        for (const r of results) {
          console.log(
            `[${r.id}] [${r.category}] ${r.project || "global"} — ${formatMemoryTimestamp(r.created_at, timezone)}\n    ${r.content}`
          );
        }
      } else if (sub === "stats") {
        const stats = await memoryStats();
        console.log(JSON.stringify(stats, null, 2));
      } else if (sub === "export") {
        const results = await listMemories(undefined, 10000);
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log("Usage: mame memory [search|list|stats|export]");
      }
      break;
    }

    case "secrets": {
      const sub = args[1];
      const vault = new Vault();
      if (sub === "list") {
        const project = args[2] || "global";
        const keys = await vault.list(project);
        console.log(`Secrets for ${project}: ${keys.join(", ") || "(none)"}`);
      } else if (sub === "set") {
        const project = args[2];
        const key = args[3];
        if (!project || !key) { console.log("Usage: mame secrets set <project> <key>"); break; }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const value = await new Promise<string>((resolve) => rl.question("Value: ", resolve));
        rl.close();
        await vault.set(project, key, value);
        console.log(`✅ Stored ${key} for ${project}`);
      } else if (sub === "delete") {
        const project = args[2];
        const key = args[3];
        if (!project || !key) { console.log("Usage: mame secrets delete <project> <key>"); break; }
        await vault.delete(project, key);
        console.log(`✅ Deleted ${key} from ${project}`);
      } else {
        console.log("Usage: mame secrets [list|set|delete]");
      }
      break;
    }

    case "magazine": {
      const sub = args[1];
      const dateFlag = args.indexOf("--date");
      const date = dateFlag >= 0 ? args[dateFlag + 1] : undefined;
      const personaFlag = args.indexOf("--persona");
      let personaName: string;
      if (personaFlag >= 0) {
        personaName = args[personaFlag + 1];
      } else {
        // Auto-detect: prefer "default", else if exactly one persona file exists use it.
        const personasDir = path.join(MAME_HOME, "personas");
        if (fs.existsSync(path.join(personasDir, "default.yml"))) {
          personaName = "default";
        } else if (fs.existsSync(personasDir)) {
          const files = fs.readdirSync(personasDir).filter((f) => f.endsWith(".yml"));
          if (files.length === 1) {
            personaName = files[0].replace(".yml", "");
          } else if (files.length === 0) {
            console.error(`No personas found in ${personasDir}`);
            process.exit(1);
          } else {
            console.error(`Multiple personas found: ${files.map((f) => f.replace(".yml", "")).join(", ")}\nSpecify one with --persona <name>`);
            process.exit(1);
          }
        } else {
          console.error(`Personas directory not found: ${personasDir}`);
          process.exit(1);
        }
      }

      // Magazine pipeline needs vault secrets (OPENROUTER_API_KEY etc) in env
      if (Vault.isAvailable()) {
        const v = new Vault();
        const globals = await v.getAll("global");
        for (const [k, val] of Object.entries(globals)) {
          if (!process.env[k]) process.env[k] = val;
        }
      }

      if (sub === "ingest") {
        const { runIngest } = await import("./magazine/ingest.js");
        const result = await runIngest(date);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      if (sub === "generate") {
        const { generateDailyDigest } = await import("./magazine/digest.js");
        const result = await generateDailyDigest({ date, personaName });
        console.log(`✅ Issue #${result.issue.issueNumber} written to ${result.path}`);
        console.log(`   Sections: ${result.issue.sections.length}`);
        console.log(`   Items: ${result.issue.sections.reduce((acc, s) => acc + s.items.length, 0)}`);
        console.log(`   Old Gold: ${result.issue.oldGold.length}`);
        console.log(`   Signal: "${result.issue.signal}"`);
        console.log(`   Runtime: ${result.issue.masthead.runtime}`);
        break;
      }

      if (sub === "run") {
        // Combined: ingest then generate. The intended heartbeat path.
        const { runIngest } = await import("./magazine/ingest.js");
        const { generateDailyDigest } = await import("./magazine/digest.js");
        const ingest = await runIngest(date);
        console.log(`📥 Ingested ${ingest.newCount} new bookmarks (scanned ${ingest.totalScanned})`);
        if (ingest.newCount === 0) {
          console.log("Nothing new to digest. Skipping generate.");
          break;
        }
        const digest = await generateDailyDigest({ date, personaName });
        console.log(`✅ Issue #${digest.issue.issueNumber} → ${digest.path}`);
        console.log(`   "${digest.issue.signal}"`);
        break;
      }

      if (sub === "stats") {
        const { archiveStats, loadState, MAGAZINE_DIR } = await import("./magazine/state.js");
        const state = loadState();
        const arch = archiveStats();
        console.log(`Magazine stats:`);
        console.log(`  Home:                  ${MAGAZINE_DIR}`);
        console.log(`  Archive total:         ${arch.total} bookmarks`);
        console.log(`  Archive oldest:        ${arch.oldest ?? "(none)"}`);
        console.log(`  Archive newest:        ${arch.newest ?? "(none)"}`);
        console.log(`  Last synced bookmark:  ${state.lastSyncedBookmarkId ?? "(none)"}`);
        console.log(`  Next issue number:     ${state.nextIssueNumber}`);
        console.log(`  Resurfaced count:      ${Object.keys(state.oldGoldResurfaceLog).length}`);
        break;
      }

      console.log(`Usage:
  mame magazine ingest [--date YYYY-MM-DD]                    Pull new bookmarks → JSONL + archive
  mame magazine generate [--date YYYY-MM-DD] [--persona name] Build issue JSON from today's JSONL
  mame magazine run [--date YYYY-MM-DD] [--persona name]      Ingest + generate end-to-end
  mame magazine stats                                         Show archive + state summary`);
      break;
    }

    case "x": {
      const sub = args[1];

      if (sub === "auth") {
        const {
          generatePkceChallenge,
          buildAuthorizeUrl,
          writePendingAuth,
          readPendingAuth,
          PENDING_AUTH_FILE,
        } = await import("./x-auth.js");

        const vault = new Vault();
        const clientId = await vault.get("global", "X_CLIENT_ID");
        if (!clientId) {
          console.error("❌ X_CLIENT_ID not found in vault. Run:\n  mame secrets set global X_CLIENT_ID");
          process.exit(1);
        }

        const state = crypto.randomUUID();
        const { verifier, challenge } = generatePkceChallenge();

        writePendingAuth({ state, verifier });

        const url = buildAuthorizeUrl(clientId, challenge, state);
        console.log("\n🔑 X OAuth 2.0 — open this URL in your browser:\n");
        console.log(url);
        console.log("\nWaiting for callback on http://localhost:3847/x/callback ...\n");
        console.log("(Mame must be running — if not, start it with: mame start)\n");

        // Poll until the pending file disappears (gateway consumed it) or timeout
        const startMs = Date.now();
        const timeoutMs = 180_000;

        await new Promise<void>((resolve, reject) => {
          const check = setInterval(async () => {
            const pending = readPendingAuth();
            if (!pending) {
              // Pending file gone — gateway handled the callback
              clearInterval(check);
              const token = await vault.get("global", "X_ACCESS_TOKEN");
              if (token) {
                const expiresAt = await vault.get("global", "X_TOKEN_EXPIRES_AT");
                const expiresDate = expiresAt
                  ? new Date(parseInt(expiresAt, 10)).toLocaleString()
                  : "unknown";
                console.log(`✅ X auth complete! Access token stored.`);
                console.log(`   Expires: ${expiresDate}`);
                resolve();
              } else {
                reject(new Error("Pending file gone but no token in vault — check gateway logs"));
              }
            } else if (Date.now() - startMs > timeoutMs) {
              clearInterval(check);
              reject(new Error("Timed out waiting for X callback (3 min). Did you open the URL in a browser?"));
            }
          }, 2000);
        });
        break;
      }

      if (sub === "status") {
        const vault = new Vault();
        const [accessToken, refreshToken, expiresAt] = await Promise.all([
          vault.get("global", "X_ACCESS_TOKEN"),
          vault.get("global", "X_REFRESH_TOKEN"),
          vault.get("global", "X_TOKEN_EXPIRES_AT"),
        ]);

        console.log("\n📊 X (Twitter) auth status\n");
        console.log(`  Access token:  ${accessToken ? "✅ stored" : "❌ not found"}`);
        console.log(`  Refresh token: ${refreshToken ? "✅ stored" : "❌ not found"}`);
        if (expiresAt) {
          const expiresMs = parseInt(expiresAt, 10);
          const msLeft = expiresMs - Date.now();
          const minsLeft = Math.round(msLeft / 60_000);
          console.log(`  Expires:       ${new Date(expiresMs).toLocaleString()} (${minsLeft > 0 ? `${minsLeft} min` : "EXPIRED"})`);
        } else {
          console.log(`  Expires:       unknown`);
        }
        console.log();
        break;
      }

      if (sub === "revoke") {
        const vault = new Vault();
        await Promise.all([
          vault.delete("global", "X_ACCESS_TOKEN").catch(() => {}),
          vault.delete("global", "X_REFRESH_TOKEN").catch(() => {}),
          vault.delete("global", "X_TOKEN_EXPIRES_AT").catch(() => {}),
        ]);
        console.log("✅ X tokens removed from vault.");
        break;
      }

      if (sub === "test-fetch") {
        const { getValidToken } = await import("./x-auth.js");
        const vault = new Vault();

        if (!Vault.isAvailable()) {
          console.error("❌ Vault not available — MAME_MASTER_KEY not set");
          process.exit(1);
        }

        console.log("Fetching X token...");
        const token = await getValidToken(vault);

        console.log("Fetching authenticated user...");
        const meRes = await fetch("https://api.x.com/2/users/me?user.fields=id,username,name", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!meRes.ok) {
          console.error(`❌ /users/me failed (${meRes.status}): ${await meRes.text()}`);
          process.exit(1);
        }
        const me = (await meRes.json()) as { data: { id: string; username: string; name: string } };
        console.log(`\nAuthenticated as: @${me.data.username} (${me.data.name})\nUser ID: ${me.data.id}\n`);

        console.log("Fetching 5 bookmarks...");
        const bmRes = await fetch(
          `https://api.x.com/2/users/${me.data.id}/bookmarks?max_results=5&tweet.fields=created_at,entities,text`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!bmRes.ok) {
          console.error(`❌ /bookmarks failed (${bmRes.status}): ${await bmRes.text()}`);
          process.exit(1);
        }
        const bm = await bmRes.json();
        console.log(JSON.stringify(bm, null, 2));
        break;
      }

      console.log(`Usage:
  mame x auth           Complete OAuth 2.0 PKCE flow (Mame must be running)
  mame x status         Show stored token status and expiry
  mame x revoke         Delete all stored X tokens
  mame x test-fetch     Fetch 5 bookmarks and print raw JSON`);
      break;
    }

    case "cost": {
      console.log("Cost reporting not yet implemented.");
      console.log("Track API usage via your provider's dashboard:");
      console.log("  Anthropic: https://console.anthropic.com/usage");
      console.log("  OpenRouter: https://openrouter.ai/activity");
      console.log("  Google: https://console.cloud.google.com/billing");
      break;
    }

    case "doctor": {
      console.log("🔍 Running health check...\n");
      console.log(`  MAME_HOME: ${MAME_HOME}`);
      console.log(`  Config: ${fs.existsSync(path.join(MAME_HOME, "config.yml")) ? "✅" : "❌ not found"}`);
      console.log(`  Memory DB: ${fs.existsSync(path.join(MAME_HOME, "memory.db")) ? "✅" : "❌ not found"}`);
      console.log(`  Vault: ${fs.existsSync(path.join(MAME_HOME, ".vault")) ? "✅" : "❌ not found"}`);
      console.log(`  HEARTBEAT.md: ${fs.existsSync(path.join(MAME_HOME, "HEARTBEAT.md")) ? "✅" : "❌ not found"}`);

      const personasDir = path.join(MAME_HOME, "personas");
      if (fs.existsSync(personasDir)) {
        const personas = fs.readdirSync(personasDir).filter((f) => f.endsWith(".yml"));
        console.log(`  Personas: ${personas.map((p) => p.replace(".yml", "")).join(", ") || "(none)"}`);
      }

      try {
        execSync("pm2 ping", { stdio: "ignore" });
        console.log(`  pm2: ✅ running`);
      } catch {
        console.log(`  pm2: ❌ not running`);
      }

      try {
        execSync("which agent-browser", { stdio: "ignore" });
        console.log(`  agent-browser: ✅ installed`);
      } catch {
        console.log(`  agent-browser: ❌ not installed`);
      }

      try {
        execSync("which claude", { stdio: "ignore" });
        console.log(`  Claude Code: ✅ installed`);
      } catch {
        console.log(`  Claude Code: ❌ not installed`);
      }
      break;
    }

    default:
      console.log(`🫘 Mame v0.1.2 — Minimal Persistent Agent

Usage:
  mame init                      First-time setup with onboarding interview
  mame init --persona            Add a new persona (CLI interview)
  mame onboard-signal +NUMBER    Wait for Signal message and onboard new user
  mame start                     Start all personas
  mame stop                      Stop all personas
  mame restart                   Restart all personas
  mame status                    Show health of all personas

  mame chat                      Interactive CLI (global context)
  mame chat --project [name]     Interactive CLI (project context)
  mame chat --persona [name]     Chat as a specific persona

  mame logs                      Tail all logs
  mame logs [persona]            Tail specific persona logs

  mame heartbeat status          Show heartbeat schedule
  mame heartbeat run             Force immediate heartbeat

  mame memory search [query]     Search memories
  mame memory list               List recent memories
  mame memory list --project     List project-scoped memories
  mame memory stats              Memory count, size, categories
  mame memory export             Export all memories as JSON

  mame secrets list              List all secret keys
  mame secrets list [project]    List project secret keys
  mame secrets set [proj] [key]  Set a secret (prompts for value)
  mame secrets delete [proj] [key]

  mame cost report               API cost breakdown
  mame doctor                    Full health check

  mame x auth                    X OAuth 2.0 PKCE flow (Mame must be running)
  mame x status                  Show X token status and expiry
  mame x revoke                  Remove stored X tokens
  mame x test-fetch              Fetch 5 bookmarks and print raw JSON

  mame magazine ingest           Pull new X bookmarks into raw JSONL + archive
  mame magazine generate         Build today's issue JSON from raw JSONL
  mame magazine run              Ingest + generate end-to-end (the heartbeat path)
  mame magazine stats            Show archive + state summary
`);
      break;
  }
}

main().catch((error) => {
  console.error("Error:", error.message || error);
  process.exit(1);
});
