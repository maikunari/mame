// src/index.ts — Main entry point for the Mame daemon

import { loadConfig, loadPersona } from "./config.js";
import { Gateway } from "./gateway.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { Vault } from "./vault.js";
import { loadTools } from "./tools/index.js";

async function main(): Promise<void> {
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
    // Default persona name
    personaName = process.env.MAME_PERSONA || "default";
  }

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

  // Start gateway (Discord, LINE, webhooks, TUI)
  const gateway = new Gateway(config, persona, vault);
  await gateway.start();

  // Start heartbeat scheduler
  const heartbeat = new HeartbeatScheduler(config, persona, gateway.notify.bind(gateway));
  await heartbeat.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
