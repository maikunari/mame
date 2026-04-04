// src/tools/report.ts — Write reports (~30 lines per spec)

import fs from "fs";
import path from "path";
import { MAME_HOME } from "../config.js";
import { registerTool, type ToolContext } from "./index.js";

const REPORTS_DIR = path.join(MAME_HOME, "reports");

registerTool({
  definition: {
    name: "write_report",
    description:
      "Write a structured report. Can save to file, send to Discord, or send via email.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Report title" },
        content: { type: "string", description: "Full markdown content of the report" },
        destination: {
          type: "string",
          enum: ["file", "discord", "email"],
          description: "Where to deliver the report (default: file)",
        },
        filename: { type: "string", description: "Filename if destination is file (auto-generated if omitted)" },
      },
      required: ["title", "content", "destination"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const title = input.title as string;
    const content = input.content as string;
    const destination = input.destination as string;
    const filename = input.filename as string | undefined;

    switch (destination) {
      case "file": {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        const date = new Date().toISOString().split("T")[0];
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").slice(0, 50);
        const name = filename || `${date}-${slug}.md`;
        const filePath = path.join(REPORTS_DIR, name);
        const fullContent = `# ${title}\n\n_Generated: ${new Date().toISOString()}_\n\n${content}`;
        fs.writeFileSync(filePath, fullContent);
        return { saved: true, path: filePath };
      }

      case "discord":
        // Discord delivery is handled by the gateway — return the content
        // and the agent loop will send it via the gateway's notify method
        return { deliver_via: "discord", title, content: content.slice(0, 2000) };

      case "email":
        // Email delivery — the agent should use the email tool to send
        return { deliver_via: "email", title, content };

      default:
        return { error: `Unknown destination: ${destination}` };
    }
  },
});
