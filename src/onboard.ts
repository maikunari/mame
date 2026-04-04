// src/onboard.ts — Onboarding interview (~60 lines per spec)

import fs from "fs";
import path from "path";
import readline from "readline";
import { MAME_HOME } from "./config.js";
import { chatCompletion, type ChatMessage } from "./model-router.js";
import { Vault } from "./vault.js";

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
6. What messaging platform? (Discord, LINE, CLI only for now)
7. Any projects or repos I should know about?
8. What tools do you need? (walk through available tools)
9. Any accounts to set up? (collect API keys, credentials for vault)
10. What should I check on automatically? (heartbeat configuration)

After gathering everything, generate the following config files and show them to the user:
- SOUL-[name].md (agent personality — written in their chosen language)
- config.yml (runtime config)
- [name].yml (persona config with tools + channel mapping)
- HEARTBEAT.md (initial heartbeat checklist — in their chosen language)

Use the write_config tool to save files when the user confirms.
Use the set_secret tool to store any API keys or credentials.

IMPORTANT: Generate valid YAML for config files. Use proper indentation.`;

const ONBOARDING_TOOLS = [
  {
    name: "write_config",
    description: "Write a configuration file to ~/.mame/",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename relative to ~/.mame/ (e.g. 'config.yml', 'personas/mike.yml', 'SOUL-mike.md')" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "set_secret",
    description: "Store an encrypted secret in the vault",
    input_schema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project scope (use 'global' for non-project secrets)" },
        key: { type: "string", description: "Secret key name (e.g. 'DISCORD_BOT_TOKEN')" },
        value: { type: "string", description: "Secret value" },
      },
      required: ["project", "key", "value"],
    },
  },
];

async function handleOnboardingTool(
  name: string,
  input: Record<string, unknown>,
  vault: Vault
): Promise<string> {
  switch (name) {
    case "write_config": {
      const filename = input.filename as string;
      const content = input.content as string;
      const filePath = path.join(MAME_HOME, filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return `✅ Saved ${filename}`;
    }
    case "set_secret": {
      const project = input.project as string;
      const key = input.key as string;
      const value = input.value as string;
      await vault.set(project, key, value);
      return `✅ Stored ${key} for ${project}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

export async function runOnboarding(model: string): Promise<void> {
  console.log("\n🫘 Welcome to Mame / Mameへようこそ\n");

  // Ensure ~/.mame/ exists
  fs.mkdirSync(MAME_HOME, { recursive: true });
  fs.mkdirSync(path.join(MAME_HOME, "personas"), { recursive: true });
  fs.mkdirSync(path.join(MAME_HOME, "reports"), { recursive: true });
  fs.mkdirSync(path.join(MAME_HOME, "browsers"), { recursive: true });

  let vault: Vault;
  try {
    vault = new Vault();
  } catch {
    console.log("⚠️  MAME_MASTER_KEY not set. Generating one...");
    const crypto = await import("crypto");
    const key = crypto.randomBytes(32).toString("hex");
    process.env.MAME_MASTER_KEY = key;
    console.log(`\nYour master key (save this somewhere safe):\n  ${key}\n`);
    console.log("Set it permanently with: export MAME_MASTER_KEY=" + key);
    console.log("");
    vault = new Vault();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const messages: ChatMessage[] = [
    { role: "user", content: "Start the onboarding interview." },
  ];

  // Start the conversation
  let response = await chatCompletion(
    model,
    ONBOARDING_PROMPT,
    messages,
    ONBOARDING_TOOLS
  );

  while (true) {
    // Handle tool calls
    while (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const results = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        const result = await handleOnboardingTool(block.name, block.input as Record<string, unknown>, vault);
        console.log(result);
        results.push({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: results as any });
      response = await chatCompletion(model, ONBOARDING_PROMPT, messages, ONBOARDING_TOOLS);
    }

    // Display agent's text response
    const text = response.content
      .filter((b): b is { type: "text"; text: string; citations: null } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (text) console.log(`\n${text}\n`);

    // Check if onboarding is complete (agent has saved all files)
    messages.push({ role: "assistant", content: response.content });

    // Get user input
    const input = await ask("> ");
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      console.log("Onboarding cancelled.");
      rl.close();
      return;
    }

    messages.push({ role: "user", content: input });
    response = await chatCompletion(model, ONBOARDING_PROMPT, messages, ONBOARDING_TOOLS);
  }
}
