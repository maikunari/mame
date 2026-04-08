// src/index.ts — Main entry point for the Mame daemon

import { loadConfig, loadPersona } from "./config.js";
import { Gateway } from "./gateway.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { Vault } from "./vault.js";
import { loadTools } from "./tools/index.js";
import { loadSystemdCredentials } from "./init-credentials.js";
import { childLogger } from "./logger.js";

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

  // Start gateway (Discord, webhooks, TUI, Signal)
  const gateway = new Gateway(config, persona, vault);
  await gateway.start();

  // Start heartbeat scheduler
  const heartbeat = new HeartbeatScheduler(config, persona, gateway.notify.bind(gateway));
  await heartbeat.start();

  log.info({ persona: personaName }, "🫘 Mame is awake");
}

main().catch((error) => {
  log.fatal({ err: error }, "Fatal error during startup");
  process.exit(1);
});
