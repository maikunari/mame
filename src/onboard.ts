// src/onboard.ts — Onboarding interview (CLI + messaging channel support)

import fs from "fs";
import path from "path";
import readline from "readline";
import { execFileSync } from "child_process";
import { MAME_HOME } from "./config.js";
import { chatCompletion, type ChatMessage } from "./model-router.js";
import { Vault } from "./vault.js";

// --- Onboarding prompt for Signal users (simpler — no platform setup questions) ---
const SIGNAL_ONBOARDING_PROMPT = `You are setting up a new Mame agent for someone who just messaged you on Signal.
This is their first message. Be warm, welcoming, and concise. Ask one question at a time.
Conduct the interview in whatever language they message you in.

You need to learn:
1. What language do they prefer? (respond in their language from the start — if they write in Japanese, switch to Japanese)
2. What should I call you? (their name)
3. What would you like to name me? (agent name — this will become your Signal display name)
4. What's my personality? (casual/warm/playful/serious — give examples)
5. What will you primarily use me for? Give warm, specific suggestions to inspire them: learning a new language? picking up a new skill or hobby? cooking and recipes? health and wellness? shopping and product research? raising a child — parenting tips, schedules, activities? planning travel? managing daily tasks? If they speak Japanese, suggest these in Japanese naturally: 「語学の勉強？新しいスキルや趣味？料理やレシピ？健康管理？お買い物？子育てのサポート？旅行の計画？」Let them pick multiple.
6. What timezone are you in? (e.g., Asia/Tokyo, America/New_York)
7. What city for weather reports? (e.g., Kamakura, Tokyo)
8. Want me to send you a morning weather brief and evening positive content? (Recommended — describe the daily themes: nature Monday, wellness Tuesday, good news Wednesday, wisdom Thursday, food Friday, culture Saturday, reflection Sunday)

After gathering everything, generate config files using these schemas.

CRITICAL: Use the write_config tool with filename "personas/{lowercase-agent-name}.yml" for the persona file.
CRITICAL: Use update_signal_profile tool to set the agent's Signal display name.

## personas/{name}.yml schema:
\`\`\`yaml
name: "AgentName"
soul: "SOUL-AgentName.md"
language: "ja"            # or "en", match their preference

models:
  default: openrouter/qwen/qwen3.5-plus-02-15
  heartbeat: openrouter/qwen/qwen3.5-plus-02-15

tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - write_report
  - self_config

signal:
  userNumbers:
    - "USER_PHONE_NUMBER_HERE"
\`\`\`

## SOUL-{name}.md:
Write a personality file in their preferred language. Include:
- Who the agent is (name, personality)
- What they help with
- Core truths (be helpful not performative, have opinions, be resourceful)
- Anti-patterns (never ask "need anything else?", don't narrate actions)
- Tools available (memory, web_search, web_fetch, browser, write_report, self_config)
- Daily reports section if they opted in

## HEARTBEAT-{name}.md:
If they opted into daily wellness reports, create a persona-specific heartbeat file (replace {LOCATION} with their city):
\`\`\`
Check the following and respond ALL_CLEAR if nothing needs attention.

## Every morning at 7:30
- Today's weather for {LOCATION}
- Brief summary: what day it is
- If today is 大安 (taian), mention it — an auspicious day in the Japanese rokuyō calendar. Search to confirm. Only mention 大安 days.

## Every evening at 18:30
- Tomorrow's weather outlook for {LOCATION}
- Daily positive content based on the day of the week:
  - Monday: Something beautiful happening in nature right now
  - Tuesday: An ayurvedic or wellness teaching or mindfulness practice
  - Wednesday: A piece of genuinely good news from a faraway country
  - Thursday: A meaningful quote from a spiritual or philosophical tradition
  - Friday: Ayurvedic food wisdom or a simple healthy recipe idea
  - Saturday: Something beautiful from world culture
  - Sunday: A gentle reflection prompt for the week ahead
- Use web_search to find real, current content.
- Remember what you've shared before (use memory tool) and never repeat within a month.
- Keep it warm, brief, and personal.
\`\`\`

## config.yml update:
Use the update_config tool to add the Signal user mapping. Pass the user's phone number and the agent name.

Show the user a summary of what you've set up and confirm it's saved.
End with a warm welcome message in their language.`;

// --- Full CLI onboarding prompt (original, for mame init) ---
const CLI_ONBOARDING_PROMPT = `You are setting up a new Mame agent instance.
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
6. What messaging platform? (Discord, Signal, LINE, CLI only)
7. **If Discord:** Ask for the Discord bot token. Then ask for Discord channel IDs. Explain: "Right-click a channel in Discord, click 'Copy Channel ID' (requires Developer Mode in Discord settings)."
8. **If Signal:** The number is already registered. Ask for the user's Signal phone number to map them.
9. Any projects or repos I should know about?
10. What tools do you need? Available: browser, web_search, web_fetch, memory, write_report, self_config, github, email, claude_code, self_modify
11. Any additional API keys to store?
12. Weather location for daily reports?
13. Want daily wellness reports? (describe the themes)
14. Any additional heartbeat checks?

After gathering everything, generate config files using the EXACT schemas below.

CRITICAL: Persona file MUST go in personas/ subdirectory.

## config.yml schema:
\`\`\`yaml
projects:
  project-name:
    path: ~/Projects/project-name

discord:
  enabled: true
  channelMap:
    "CHANNEL_ID": null
  defaultChannel: "CHANNEL_ID"

signal:
  enabled: true
  number: "+AGENT_NUMBER"
  userMap:
    "+USER_NUMBER": null

webhook:
  port: 3847
timezone: Asia/Tokyo
\`\`\`

## personas/{name}.yml schema:
\`\`\`yaml
name: "AgentName"
soul: "SOUL-AgentName.md"
language: "en"

models:
  default: openrouter/qwen/qwen3.5-plus-02-15
  heartbeat: openrouter/qwen/qwen3.5-plus-02-15

tools:
  - browser
  - web_search
  - web_fetch
  - memory
  - write_report
  - self_config

discord:
  channelMap:
    "CHANNEL_ID": null

signal:
  userNumbers:
    - "+USER_NUMBER"
\`\`\`

## SOUL and HEARTBEAT files as described in the interview.

Show the user what you've generated and ask for confirmation before saving.`;

// --- Onboarding tools ---
function getOnboardingTools(channel: "cli" | "signal", signalNumber?: string) {
  const tools: any[] = [
    {
      name: "write_config",
      description: "Write a configuration file to ~/.mame/. Use 'personas/name.yml' for persona files.",
      input_schema: {
        type: "object" as const,
        properties: {
          filename: { type: "string", description: "Filename relative to ~/.mame/" },
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
          project: { type: "string", description: "Project scope (use 'global' for shared secrets)" },
          key: { type: "string", description: "Secret key name" },
          value: { type: "string", description: "Secret value" },
        },
        required: ["project", "key", "value"],
      },
    },
  ];

  if (channel === "signal" && signalNumber) {
    tools.push({
      name: "update_signal_profile",
      description: "Update the Signal display name for this agent. Call this after the user picks an agent name.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "The agent's display name on Signal" },
        },
        required: ["name"],
      },
    });
    tools.push({
      name: "update_config",
      description: "Add a Signal user mapping to config.yml so this user's messages are routed correctly.",
      input_schema: {
        type: "object" as const,
        properties: {
          user_phone: { type: "string", description: "The user's Signal phone number (e.g. +819012345678)" },
          persona_name: { type: "string", description: "The lowercase persona name (matches the persona yml filename)" },
        },
        required: ["user_phone", "persona_name"],
      },
    });
  }

  return tools;
}

// --- Tool execution ---
async function handleOnboardingTool(
  name: string,
  input: Record<string, unknown>,
  vault: Vault,
  signalNumber?: string
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
    case "update_signal_profile": {
      const agentName = input.name as string;
      if (!signalNumber) return "No Signal number configured";
      try {
        execFileSync("signal-cli", ["-u", signalNumber, "updateProfile", "--given-name", agentName], { timeout: 15000 });
        return `Signal profile name updated to "${agentName}"`;
      } catch (err) {
        return `Failed to update Signal profile: ${err}`;
      }
    }
    case "update_config": {
      const userPhone = input.user_phone as string;
      const personaName = input.persona_name as string;
      // Read existing config, add signal user mapping
      const configPath = path.join(MAME_HOME, "config.yml");
      let configContent = "";
      if (fs.existsSync(configPath)) {
        configContent = fs.readFileSync(configPath, "utf-8");
      }
      // Append signal config if not present
      if (!configContent.includes("signal:")) {
        configContent += `\nsignal:\n  enabled: true\n  number: "${signalNumber}"\n  userMap:\n    "${userPhone}": null\n`;
      } else if (!configContent.includes(userPhone)) {
        // Add user to existing signal userMap
        configContent = configContent.replace(
          /userMap:\n/,
          `userMap:\n    "${userPhone}": null\n`
        );
      }
      fs.writeFileSync(configPath, configContent);
      return `Added Signal user ${userPhone} to config.yml for persona ${personaName}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// Extract text from response content blocks
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

// --- Generic onboarding conversation engine ---
// Works over any channel via send/receive callbacks
export async function runOnboardingConversation(
  model: string,
  prompt: string,
  tools: any[],
  vault: Vault,
  send: (text: string) => Promise<void>,
  receive: () => Promise<string>,
  signalNumber?: string,
  initialMessage?: string,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "user", content: initialMessage || "Start the onboarding interview." },
  ];

  let response = await chatCompletion(model, prompt, messages, tools);

  while (true) {
    // Handle tool calls
    while (response.stop_reason === "tool_use") {
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const results = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        const result = await handleOnboardingTool(block.name, block.input as Record<string, unknown>, vault, signalNumber);
        await send(`  ✅ ${result}`);
        results.push({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: results as any });
      response = await chatCompletion(model, prompt, messages, tools);
    }

    // Send agent's text response
    const text = extractText(response.content as unknown[]);
    if (text) await send(text);

    messages.push({ role: "assistant", content: response.content });

    // Get user input
    const input = await receive();
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      await send("Onboarding cancelled.");
      return;
    }

    messages.push({ role: "user", content: input });
    response = await chatCompletion(model, prompt, messages, tools);
  }
}

// --- CLI onboarding (mame init) ---
export async function runOnboarding(model: string): Promise<void> {
  console.log("\n🫘 Welcome to Mame / Mameへようこそ\n");

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
    const keyFile = path.join(MAME_HOME, ".master-key");
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    console.log(`\n  Master key saved to ${keyFile} (permissions: owner-only)`);
    console.log(`  Back it up, then add to your shell profile:`);
    console.log(`    echo 'export MAME_MASTER_KEY=$(cat ${keyFile})' >> ~/.bashrc\n`);
    vault = new Vault();
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

  const tools = getOnboardingTools("cli");

  await runOnboardingConversation(
    model,
    CLI_ONBOARDING_PROMPT,
    tools,
    vault,
    async (text) => console.log(`\n${text}\n`),
    () => ask("> "),
  );

  rl.close();
}

// --- Signal onboarding (triggered by unknown number) ---
export async function runSignalOnboarding(
  model: string,
  userPhone: string,
  initialMessage: string,
  signalNumber: string,
  sendFn: (text: string) => Promise<void>,
  receiveFn: () => Promise<string>,
): Promise<void> {
  const vault = new Vault();

  const prompt = SIGNAL_ONBOARDING_PROMPT.replace(
    /USER_PHONE_NUMBER_HERE/g,
    userPhone
  );

  const tools = getOnboardingTools("signal", signalNumber);

  await runOnboardingConversation(
    model,
    prompt,
    tools,
    vault,
    sendFn,
    receiveFn,
    signalNumber,
    initialMessage,
  );
}
