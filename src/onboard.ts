// src/onboard.ts — Onboarding interview (CLI + messaging channel support)
//
// Evening 3 of the pi-ai migration. What changed:
//
// - runOnboardingConversation() now uses pi-agent-core's Agent class instead
//   of a hand-rolled chatCompletion + tool-execution while-loop. Every call
//   to Agent.prompt() runs one model turn (plus any tool calls it makes),
//   and the loop between turns is driven by the send/receive callbacks.
//
// - Onboarding tools are now AgentTool<TypeBox> shaped, defined inline in
//   getOnboardingAgentTools(). They close over the send callback so they
//   can give the user per-tool feedback as work happens.
//
// - The two prompt strings (SIGNAL_ONBOARDING_PROMPT, CLI_ONBOARDING_PROMPT)
//   are unchanged.

import fs from "fs";
import path from "path";
import readline from "readline";
import { execFileSync } from "child_process";
import { MAME_HOME } from "./config.js";
import { Vault } from "./vault.js";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  Type,
  getModel,
  type KnownProvider,
  type Static,
  type TextContent,
} from "@mariozechner/pi-ai";
import { parseModelString } from "./model-router.js";

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
There are two kinds of scheduled tasks below:
**Daily reports** — always deliver the full report. Never reply with just "ALL_CLEAR".
**Monitoring checks** — only reply if something needs attention. Reply exactly "ALL_CLEAR" if everything is fine.

## Every morning at 7:30 — DAILY REPORT (always send)
Compose a warm morning brief that includes:
- Today's weather for {LOCATION}
- The day of the week and date
- If today is 大安 (taian), mention it warmly — an auspicious day in the Japanese rokuyō calendar. Use web_search to confirm. Only mention 大安 days.
- Daily positive content based on the day of the week:
  - Monday: Something beautiful happening in nature right now
  - Tuesday: An ayurvedic or wellness teaching or mindfulness practice
  - Wednesday: A piece of genuinely good news from a faraway country
  - Thursday: A meaningful quote from a spiritual or philosophical tradition
  - Friday: Ayurvedic food wisdom or a simple healthy recipe idea
  - Saturday: Something beautiful from world culture
  - Sunday: A gentle reflection prompt for the week ahead
- Use web_search to find real, current content. Don't make things up.
- Remember what you've shared before (use memory tool) and never repeat within a month.
- Keep it warm, brief, and personal. Always send this — never suppress with ALL_CLEAR.

## Every evening at 18:30 — DAILY REPORT (always send)
- Tomorrow's weather outlook for {LOCATION}
- Anything noteworthy coming up
Always send this — never suppress with ALL_CLEAR.
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
6. What messaging platform? (Discord, Signal, CLI only)
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

// --------------------------------------------------------------------------
// AgentTool definitions for onboarding. Unlike the main tool registry in
// src/tools/, these are defined inline and only exist for the duration of
// an onboarding session. They close over send() so they can report progress
// to the user as files get written.
// --------------------------------------------------------------------------

const WriteConfigParams = Type.Object({
  filename: Type.String({ description: "Filename relative to ~/.mame/" }),
  content: Type.String({ description: "File content to write" }),
});

const SetSecretParams = Type.Object({
  project: Type.String({ description: "Project scope (use 'global' for shared secrets)" }),
  key: Type.String({ description: "Secret key name" }),
  value: Type.String({ description: "Secret value" }),
});

const UpdateSignalProfileParams = Type.Object({
  name: Type.String({ description: "The agent's display name on Signal" }),
});

const UpdateConfigParams = Type.Object({
  user_phone: Type.String({ description: "The user's Signal phone number (e.g. +819012345678)" }),
  persona_name: Type.String({ description: "The lowercase persona name (matches the persona yml filename)" }),
});

function getOnboardingAgentTools(
  channel: "cli" | "signal",
  vault: Vault,
  send: (text: string) => Promise<void>,
  signalNumber?: string
): AgentTool<any>[] {
  const writeConfig: AgentTool<typeof WriteConfigParams> = {
    name: "write_config",
    label: "write_config",
    description: "Write a configuration file to ~/.mame/. Use 'personas/name.yml' for persona files.",
    parameters: WriteConfigParams,
    execute: async (_toolCallId, params: Static<typeof WriteConfigParams>) => {
      const filePath = path.join(MAME_HOME, params.filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, params.content);
      const msg = `Saved ${params.filename}`;
      await send(`  ✅ ${msg}`);
      return {
        content: [{ type: "text", text: msg }],
        details: { filename: params.filename, bytes: params.content.length },
      };
    },
  };

  const setSecret: AgentTool<typeof SetSecretParams> = {
    name: "set_secret",
    label: "set_secret",
    description: "Store an encrypted secret in the vault",
    parameters: SetSecretParams,
    execute: async (_toolCallId, params: Static<typeof SetSecretParams>) => {
      await vault.set(params.project, params.key, params.value);
      const msg = `Stored ${params.key} for ${params.project}`;
      await send(`  ✅ ${msg}`);
      return {
        content: [{ type: "text", text: msg }],
        details: { project: params.project, key: params.key },
      };
    },
  };

  const tools: AgentTool<any>[] = [
    writeConfig as AgentTool<any>,
    setSecret as AgentTool<any>,
  ];

  if (channel === "signal" && signalNumber) {
    const updateSignalProfile: AgentTool<typeof UpdateSignalProfileParams> = {
      name: "update_signal_profile",
      label: "update_signal_profile",
      description:
        "Update the Signal display name for this agent. Call this after the user picks an agent name.",
      parameters: UpdateSignalProfileParams,
      execute: async (_toolCallId, params: Static<typeof UpdateSignalProfileParams>) => {
        try {
          execFileSync(
            "signal-cli",
            ["-u", signalNumber, "updateProfile", "--given-name", params.name],
            { timeout: 15000 }
          );
          const msg = `Signal profile name updated to "${params.name}"`;
          await send(`  ✅ ${msg}`);
          return {
            content: [{ type: "text", text: msg }],
            details: { name: params.name },
          };
        } catch (err) {
          const errMsg = `Failed to update Signal profile: ${err instanceof Error ? err.message : String(err)}`;
          await send(`  ⚠️ ${errMsg}`);
          throw new Error(errMsg);
        }
      },
    };

    const updateConfig: AgentTool<typeof UpdateConfigParams> = {
      name: "update_config",
      label: "update_config",
      description:
        "Add a Signal user mapping to config.yml so this user's messages are routed correctly.",
      parameters: UpdateConfigParams,
      execute: async (_toolCallId, params: Static<typeof UpdateConfigParams>) => {
        const configPath = path.join(MAME_HOME, "config.yml");
        let configContent = "";
        if (fs.existsSync(configPath)) {
          configContent = fs.readFileSync(configPath, "utf-8");
        }
        if (!configContent.includes("signal:")) {
          configContent += `\nsignal:\n  enabled: true\n  number: "${signalNumber}"\n  userMap:\n    "${params.user_phone}": null\n`;
        } else if (!configContent.includes(params.user_phone)) {
          configContent = configContent.replace(
            /userMap:\n/,
            `userMap:\n    "${params.user_phone}": null\n`
          );
        }
        fs.writeFileSync(configPath, configContent);
        const msg = `Added Signal user ${params.user_phone} to config.yml for persona ${params.persona_name}`;
        await send(`  ✅ ${msg}`);
        return {
          content: [{ type: "text", text: msg }],
          details: { user_phone: params.user_phone, persona: params.persona_name },
        };
      },
    };

    tools.push(updateSignalProfile as AgentTool<any>);
    tools.push(updateConfig as AgentTool<any>);
  }

  return tools;
}

// --------------------------------------------------------------------------
// Extract the most recent assistant text reply from an Agent's state.
// Mirrors the helper in src/agent.ts — walks the transcript backwards, picks
// the last assistant message, joins its text content blocks.
// --------------------------------------------------------------------------
function extractLatestAssistantText(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        parts.push((block as TextContent).text);
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

// --------------------------------------------------------------------------
// Generic onboarding conversation loop. Drives a pi-agent-core Agent via
// send/receive callbacks so the same logic works for CLI readline and
// Signal messaging.
// --------------------------------------------------------------------------
export async function runOnboardingConversation(
  model: string,
  prompt: string,
  vault: Vault,
  channel: "cli" | "signal",
  send: (text: string) => Promise<void>,
  receive: () => Promise<string>,
  signalNumber?: string,
  initialMessage?: string
): Promise<void> {
  const route = parseModelString(model);
  let piModel;
  try {
    piModel = getModel(route.backend as KnownProvider as any, route.modelId as any);
  } catch (err) {
    await send(
      `Onboarding failed: could not resolve model ${model} (${err instanceof Error ? err.message : String(err)})`
    );
    return;
  }
  if (!piModel) {
    await send(`Onboarding failed: model ${model} is not registered in pi-ai's catalog.`);
    return;
  }

  const tools = getOnboardingAgentTools(channel, vault, send, signalNumber);

  const agent = new Agent({
    initialState: {
      systemPrompt: prompt,
      model: piModel,
      tools,
      thinkingLevel: "off",
      messages: [],
    },
  });

  // Seed the conversation — either with the first user message (Signal
  // users) or a synthetic "start the interview" prompt (CLI users).
  const firstInput = initialMessage || "Start the onboarding interview.";

  try {
    await agent.prompt(firstInput);
  } catch (err) {
    await send(`Onboarding error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  while (true) {
    if (agent.state.errorMessage) {
      await send(`Onboarding error: ${agent.state.errorMessage}`);
      return;
    }

    const text = extractLatestAssistantText(agent);
    if (text) {
      await send(text);
    }

    const input = await receive();
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      await send("Onboarding cancelled.");
      return;
    }

    try {
      await agent.prompt(input);
    } catch (err) {
      await send(`Onboarding error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  await runOnboardingConversation(
    model,
    CLI_ONBOARDING_PROMPT,
    vault,
    "cli",
    async (text) => console.log(`\n${text}\n`),
    () => ask("> ")
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
  receiveFn: () => Promise<string>
): Promise<void> {
  const vault = new Vault();

  const prompt = SIGNAL_ONBOARDING_PROMPT.replace(/USER_PHONE_NUMBER_HERE/g, userPhone);

  await runOnboardingConversation(
    model,
    prompt,
    vault,
    "signal",
    sendFn,
    receiveFn,
    signalNumber,
    initialMessage
  );
}
