#!/usr/bin/env node
// src/cli.ts — CLI entry point for `npx mame` commands

import { execSync } from "child_process";
import { runOnboarding } from "./onboard.js";
import { MAME_HOME, loadConfig } from "./config.js";
import { Vault } from "./vault.js";
import { recall, listMemories, memoryStats } from "./memory.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { loadTools } from "./tools/index.js";
import readline from "readline";
import path from "path";
import fs from "fs";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  // Load all tool registrations
  await loadTools();
  switch (command) {
    case "init": {
      const isPersona = args.includes("--persona");
      const model = process.env.MAME_ONBOARD_MODEL || "google/gemini-3.1-flash-lite-preview";
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
      const model = process.env.MAME_ONBOARD_MODEL || "google/gemini-3.1-flash-lite-preview";

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
        const persona = args.includes("--persona") ? args[args.indexOf("--persona") + 1] : "default";
        const { loadPersona } = await import("./config.js");
        const config = loadConfig();
        const personaConfig = loadPersona(persona);
        const scheduler = new HeartbeatScheduler(config, personaConfig, async (_p, msg) => console.log(msg));
        const result = await scheduler.runNow();
        console.log(result);
      } else {
        console.log("Usage: mame heartbeat [status|run]");
      }
      break;
    }

    case "memory": {
      const sub = args[1];
      if (sub === "search") {
        const query = args.slice(2).join(" ");
        if (!query) { console.log("Usage: mame memory search <query>"); break; }
        const results = await recall(query);
        for (const r of results) {
          console.log(`[${r.id}] [${r.category}] ${r.content}`);
        }
        if (results.length === 0) console.log("No memories found.");
      } else if (sub === "list") {
        const projectFlag = args.indexOf("--project");
        const project = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
        const results = await listMemories(project);
        for (const r of results) {
          console.log(`[${r.id}] [${r.category}] ${r.project || "global"}: ${r.content}`);
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
`);
      break;
  }
}

main().catch((error) => {
  console.error("Error:", error.message || error);
  process.exit(1);
});
