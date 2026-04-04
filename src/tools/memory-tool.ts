// src/tools/memory-tool.ts — Memory tool interface (~20 lines per spec)
// Named memory-tool.ts to avoid conflict with ../memory.ts

import { remember, recall, forget } from "../memory.js";
import { registerTool, type ToolContext } from "./index.js";

registerTool({
  definition: {
    name: "memory",
    description:
      "Store and retrieve memories. The agent decides what's worth remembering. " +
      "Use 'remember' to store, 'recall' to search, 'forget' to delete.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["remember", "recall", "forget"] },
        content: { type: "string", description: "What to remember or search for" },
        project: { type: "string", description: "Project scope (optional)" },
        category: {
          type: "string",
          enum: ["learning", "preference", "decision", "skill", "person", "general"],
          description: "Memory category (default: general)",
        },
        importance: {
          type: "number",
          description: "0-1 importance score (default 0.5)",
        },
        id: { type: "number", description: "Memory ID (for forget)" },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;
    const content = input.content as string | undefined;
    const project = input.project as string | undefined;
    const category = input.category as string | undefined;
    const importance = input.importance as number | undefined;
    const id = input.id as number | undefined;

    switch (action) {
      case "remember": {
        if (!content) return { error: "content required for remember" };
        const memId = await remember(content, project, category, importance);
        return { stored: true, id: memId };
      }

      case "recall": {
        if (!content) return { error: "content/query required for recall" };
        const results = await recall(content, project);
        return { memories: results.map((m) => ({ id: m.id, content: m.content, category: m.category, project: m.project })) };
      }

      case "forget": {
        if (!id) return { error: "id required for forget" };
        await forget(id);
        return { deleted: true, id };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  },
});
