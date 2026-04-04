// src/improve.ts — Skill extraction (~30 lines per spec)
// After complex multi-tool tasks (5+ tool calls), the agent reflects

import type Anthropic from "@anthropic-ai/sdk";
import { remember } from "./memory.js";
import { chatCompletion, type ChatMessage } from "./model-router.js";

export async function maybeExtractSkill(
  conversation: ChatMessage[],
  toolCallCount: number,
  model: string
): Promise<void> {
  if (toolCallCount < 5) return; // Only for complex tasks

  try {
    const response = await chatCompletion(
      model,
      "You extract reusable skills from task executions.",
      [{
        role: "user",
        content: `Review this task execution. If you solved something non-trivial
that might come up again, write a concise skill document.

If this was routine and not worth documenting, reply SKIP.

Conversation:
${JSON.stringify(conversation.slice(-20))}

Format if documenting:
## [Skill Name]
**When to use:** [trigger conditions]
**Steps:** [what to do]
**Gotchas:** [things that tripped you up]`,
      }],
      [], // no tools
      1000
    );

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (text.trim() === "SKIP" || text.trim().length < 20) return;

    // Store as a memory with high importance
    await remember(text, undefined, "skill", 0.9);
    console.log("[improve] Extracted skill from complex task");
  } catch (error) {
    // Skill extraction is best-effort — don't break the main flow
    console.error(`[improve] Skill extraction failed: ${error}`);
  }
}
