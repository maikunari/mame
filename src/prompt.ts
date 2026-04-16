// src/prompt.ts — System prompt assembly (~30 lines per spec)

import { formatCurrentTimeInTimezone, formatMemoryTimestamp, type Memory } from "./memory.js";

export interface PromptContext {
  soul: string;
  memories: Memory[];
  projectContext?: string;
  /**
   * IANA timezone for formatting memory timestamps. Comes from
   * config.yml's `timezone` field. Defaults to Asia/Tokyo if omitted —
   * memories still format correctly, just in JST.
   */
  timezone?: string;
  /**
   * The model ID this agent is running on (e.g. "openrouter/minimax/minimax-m2.7").
   * Injected into the prompt so the agent can answer "what model are you?"
   * accurately instead of hallucinating from stale memory.
   */
  modelId?: string;
  /**
   * The persona name (e.g. "Mame", "Mame-Mini"). Lets the agent ground
   * its identity in the current config rather than conversational drift.
   */
  personaName?: string;
}

export function buildSystemPrompt({
  soul,
  memories,
  projectContext,
  timezone,
  modelId,
  personaName,
}: PromptContext): string {
  const tz = timezone || "Asia/Tokyo";

  // Inject the current wall-clock time at the top of every system prompt
  // so the model always knows what day/time it is in the user's
  // timezone. Addresses the "Mame loses track of time mid-conversation"
  // problem: without this, the only temporal reference the model has is
  // its training cutoff (weeks or months stale) plus stored memory
  // timestamps, which it has to reason about indirectly. With this, it
  // sees "Wednesday, 2026-04-08T13:45:12+09:00 JST" on every turn —
  // unambiguous anchor, no inference required.
  const currentTime = formatCurrentTimeInTimezone(tz);

  // Prefix each memory with its stored-at timestamp in the user's local
  // timezone with an ISO offset, a short TZ label, and a relative-time
  // suffix. Lets the model reason about recency ("this was 3 weeks ago")
  // and cross-timezone context ("this was 9 AM JST / 8 PM EST the day
  // before") without guessing what the timestamp refers to.
  const memorySection = memories.length
    ? `## Relevant Memories
${memories
  .map((m) => `- [${formatMemoryTimestamp(m.created_at, tz)}] ${m.content}`)
  .join("\n")}`
    : "";

  const identitySection = modelId || personaName
    ? `## Your Identity${personaName ? `\nYou are **${personaName}**.` : ""}${modelId ? `\nYou are running on model: **${modelId}**.` : ""}
When asked what model you're using or who you are, use this section — not anything you might recall from memory. Memories about past model configurations are historical context, not current truth.`
    : "";

  return `${soul}
${identitySection ? "\n" + identitySection + "\n" : ""}
## Current Context
It is currently ${currentTime}.
When users ask about "today", "yesterday", "last week", or reference times, use this as your anchor — not your training data cutoff. When scheduling or discussing times with people in other timezones, explicitly state both local and remote times to avoid ambiguity.

${projectContext ? `## Current Project\n${projectContext}` : ""}

${memorySection}

## Tools Available
You have tools for: web search, web fetch, browser (with persistent logins),
GitHub operations, email (AgentMail), Claude Code dispatch, memory, and reports.
Use them as needed.

## Rules
- For any code changes, ALWAYS dispatch to Claude Code. Never write code yourself.
- For destructive actions (deploy, delete, send email to external), ask for approval first.
- After completing complex tasks, store key learnings in memory.
- Be concise in Discord. Be detailed in reports.`;
}
