// src/tools/browser.ts — agent-browser wrapper (~80 lines per spec)
// Uses agent-browser CLI from https://github.com/vercel-labs/agent-browser

import { execFile } from "child_process";
import path from "path";
import { MAME_HOME } from "../config.js";
import { registerTool, type ToolContext } from "./index.js";

registerTool({
  definition: {
    name: "browser",
    description:
      "Browse the web with persistent login sessions. Use for any website interaction — shopping, dashboards, authenticated pages, form filling, data extraction.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "open",        // Navigate to URL
            "snapshot",    // Get page structure with element refs
            "screenshot",  // Visual capture
            "click",       // Click element by ref
            "type",        // Type into element by ref
            "extract",     // Extract text/data from page
            "scroll",      // Scroll page
            "back",        // Navigate back
            "wait",        // Wait for element/condition
          ],
        },
        url: { type: "string" },
        ref: {
          type: "string",
          description: "Element reference from snapshot (e.g. @e1, @e2)",
        },
        text: { type: "string", description: "Text to type or search for" },
        profile: {
          type: "string",
          description: "Named profile for session persistence (e.g. 'amazon-jp', 'newrelic')",
        },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;
    const profile = input.profile as string | undefined;
    const url = input.url as string | undefined;
    const ref = input.ref as string | undefined;
    const text = input.text as string | undefined;

    const args: string[] = [];

    // Use persistent profile if specified
    if (profile) {
      args.push("--profile", path.join(MAME_HOME, "browsers", profile));
    }

    switch (action) {
      case "open":
        if (!url) return { error: "url required for open action" };
        args.push("open", url);
        break;
      case "snapshot":
        args.push("snapshot");
        break;
      case "screenshot": {
        const screenshotPath = `/tmp/mame-screenshot-${Date.now()}.png`;
        args.push("screenshot", "--annotate", screenshotPath);
        return new Promise((resolve) => {
          execFile("agent-browser", args, { timeout: 30000 }, (err, stdout, stderr) => {
            resolve({
              success: !err,
              path: screenshotPath,
              output: stdout,
              error: stderr || err?.message,
            });
          });
        });
      }
      case "click":
        if (!ref) return { error: "ref required for click action" };
        args.push("click", ref);
        break;
      case "type":
        if (!ref || !text) return { error: "ref and text required for type action" };
        args.push("type", ref, text);
        break;
      case "extract":
        args.push("extract", "--text");
        break;
      case "scroll":
        args.push("scroll", text || "down");
        break;
      case "back":
        args.push("back");
        break;
      case "wait":
        if (!text) return { error: "text required for wait action (element selector or condition)" };
        args.push("wait", text);
        break;
      default:
        return { error: `Unknown action: ${action}` };
    }

    return new Promise((resolve) => {
      execFile("agent-browser", args, { timeout: 30000 }, (err, stdout, stderr) => {
        resolve({ success: !err, output: stdout, error: stderr || err?.message });
      });
    });
  },
});
