// src/prompt.ts — System prompt assembly (~30 lines per spec)

import { formatMemoryTimestamp, type Memory } from "./memory.js";

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
}

export function buildSystemPrompt({
  soul,
  memories,
  projectContext,
  timezone,
}: PromptContext): string {
  const tz = timezone || "Asia/Tokyo";

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

  return `${soul}

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
