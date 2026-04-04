// src/prompt.ts — System prompt assembly (~30 lines per spec)

import type { Memory } from "./memory.js";

export interface PromptContext {
  soul: string;
  memories: Memory[];
  projectContext?: string;
}

export function buildSystemPrompt({ soul, memories, projectContext }: PromptContext): string {
  return `${soul}

${projectContext ? `## Current Project\n${projectContext}` : ""}

${memories.length ? `## Relevant Memories\n${memories.map((m) => `- ${m.content}`).join("\n")}` : ""}

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
