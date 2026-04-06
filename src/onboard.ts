// src/onboard.ts — Onboarding interview

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
4. What's my personality? (serious/casual/playful/technical)
5. What will you primarily use me for? (coding, research, shopping, daily tasks, etc.)
6. What messaging platform? (Discord, LINE, CLI only)
7. **If Discord:** Ask for the Discord bot token. Then ask for Discord channel IDs they want the agent to respond in. Explain: "Right-click a channel in Discord, click 'Copy Channel ID' (requires Developer Mode in Discord settings)." Ask which channel should be the default for notifications.
8. **If LINE:** Ask for LINE Channel Access Token and Channel Secret.
9. Any projects or repos I should know about? (get name and local path for each)
10. What tools do you need? Available tools: browser, web_search, web_fetch, memory, write_report, github, email, claude_code, self_modify
11. Any additional API keys to store? (e.g., BRAVE_SEARCH_API_KEY, SERPER_API_KEY, GITHUB_TOKEN)
12. **Weather location:** "What city or region should I use for weather reports?" (e.g., "Kamakura", "Tokyo", "San Francisco")
13. **Daily wellness reports (recommended):** "Want me to send you a morning weather brief and an evening positive content report? Each evening has a rotating theme — nature on Monday, wellness on Tuesday, good news on Wednesday, wisdom on Thursday, food & health on Friday, culture on Saturday, and a reflection prompt on Sunday." If yes, use the heartbeat template below with their location and timezone filled in.
14. Any additional heartbeat checks? (e.g., "check my email every morning", "monitor my deployments")

After gathering everything, generate config files using the EXACT schemas below.

CRITICAL: Persona file MUST go in personas/ subdirectory. Use write_config with filename "personas/{name}.yml".

## config.yml schema:
\`\`\`yaml
projects:
  project-name:
    path: ~/Projects/project-name
    github: owner/repo          # optional

discord:
  enabled: true
  channelMap:
    "CHANNEL_ID_HERE": project-name   # or null for global context
  defaultChannel: "CHANNEL_ID_HERE"

# Include if LINE is used:
line:
  enabled: true
  userMap:
    "USER_ID_HERE": null
  defaultUserId: "USER_ID_HERE"

webhook:
  port: 3847

timezone: Asia/Tokyo    # or user's timezone
\`\`\`

## personas/{name}.yml schema:
\`\`\`yaml
name: "AgentName"
soul: "SOUL-AgentName.md"
language: "en"            # or "ja"

models:
  default: google/gemini-3.1-flash-lite-preview
  heartbeat: google/gemini-3.1-flash-lite-preview

tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - write_report

discord:                  # include if using Discord
  channelMap:
    "CHANNEL_ID": project-name    # or null
\`\`\`

## SOUL-{name}.md:
Write a personality file based on the user's preferences. Include sections for personality, core truths, boundaries, and tools available.

## HEARTBEAT.md:
If the user opted into daily wellness reports, use this template (replace {LOCATION} with their city):
\`\`\`
Check the following and respond ALL_CLEAR if nothing needs attention.
Only alert me if something is genuinely wrong or needs action.

## Every morning at 7:30
- Today's weather for {LOCATION}
- Brief summary: what day it is, anything scheduled

## Every evening at 18:30
- Tomorrow's weather outlook for {LOCATION}
- Daily positive content based on the day of the week:
  - Monday: Something beautiful happening in nature right now, anywhere in the world
  - Tuesday: An ayurvedic or wellness teaching, health tip, or mindfulness practice
  - Wednesday: A piece of genuinely good news from a faraway country
  - Thursday: A meaningful quote or teaching from a spiritual or philosophical tradition
  - Friday: Ayurvedic food wisdom, seasonal eating advice, or a simple healthy recipe idea
  - Saturday: Something beautiful from world culture — art, music, architecture, or tradition
  - Sunday: A gentle reflection prompt for the week ahead
- Use web_search to find real, current content. Don't make things up.
- Remember what you've shared before (use memory tool) and never repeat within a month.
- Keep it warm, brief, and personal. This should feel like a small gift, not a newsletter.
\`\`\`

If the user declined daily reports, write a minimal heartbeat:
\`\`\`
Check the following and respond ALL_CLEAR if nothing needs attention.

## Every morning at 9:00
- Check if there's anything important today
\`\`\`

Add any additional heartbeat checks the user requested.

Show the user what you've generated and ask for confirmation before saving.
Use the write_config tool to save each file.
Use the set_secret tool to store any API keys or credentials.`;

const ONBOARDING_TOOLS = [
  {
    name: "write_config",
    description: "Write a configuration file to ~/.mame/. Use 'personas/name.yml' for persona files.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename relative to ~/.mame/ (e.g. 'config.yml', 'personas/mike.yml', 'SOUL-Mame.md', 'HEARTBEAT.md')" },
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
        project: { type: "string", description: "Project scope (use 'global' for non-project secrets like DISCORD_BOT_TOKEN)" },
        key: { type: "string", description: "Secret key name (e.g. 'DISCORD_BOT_TOKEN', 'GOOGLE_API_KEY')" },
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
      return `Saved ${filename}`;
    }
    case "set_secret": {
      const project = input.project as string;
      const key = input.key as string;
      const value = input.value as string;
      await vault.set(project, key, value);
      return `Stored ${key} for ${project}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// Extract text from response content blocks (handles both Anthropic and Google formats)
function extractText(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && "type" in block) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
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

    // Write key to a protected file instead of printing to console
    const keyFile = path.join(MAME_HOME, ".master-key");
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    console.log(`\n  Master key saved to ${keyFile} (permissions: owner-only)`);
    console.log(`  Back it up, then add to your shell profile:`);
    console.log(`    echo 'export MAME_MASTER_KEY=$(cat ${keyFile})' >> ~/.bashrc\n`);
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
        console.log(`  ✅ ${result}`);
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
    const text = extractText(response.content as unknown[]);

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
