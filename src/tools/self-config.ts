// src/tools/self-config.ts — Read and edit files in ~/.mame/
// Lets Mame see and update her own config, SOUL, HEARTBEAT, and persona files.

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { MAME_HOME } from "../config.js";
import { registerTool, type ToolContext } from "./index.js";

/**
 * Validate YAML/JSON content before writing to prevent the agent from
 * breaking her own config with malformed output.
 */
function validateStructuredContent(
  relativePath: string,
  content: string
): string | null {
  if (relativePath.endsWith(".yml") || relativePath.endsWith(".yaml")) {
    try {
      parseYaml(content);
    } catch (err) {
      return `Invalid YAML — refusing to write. Parse error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (relativePath.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (err) {
      return `Invalid JSON — refusing to write. Parse error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null; // valid
}

// Only allow access within ~/.mame/ — no escaping
function resolveSafePath(filename: string): string | null {
  const resolved = path.resolve(MAME_HOME, filename);
  if (!resolved.startsWith(path.resolve(MAME_HOME))) {
    return null; // Path traversal attempt
  }
  return resolved;
}

// Files that should never be written by the agent
const READ_ONLY_PATTERNS = [
  /\.vault\//,  // Encrypted secrets — use the vault tool
  /\.enc$/,
];

function isReadOnly(filename: string): boolean {
  return READ_ONLY_PATTERNS.some((p) => p.test(filename));
}

registerTool({
  definition: {
    name: "self_config",
    description:
      "Read and edit your own configuration files in ~/.mame/. " +
      "Use this to view or update SOUL.md, HEARTBEAT.md, config.yml, persona files, etc. " +
      "You can also list directory contents to discover what files exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "list", "append"],
          description: "read: read a file, write: overwrite a file, append: add to end of file, list: list directory contents",
        },
        path: {
          type: "string",
          description: "File or directory path relative to ~/.mame/ (e.g. 'SOUL-Mame.md', 'HEARTBEAT.md', 'config.yml', 'personas/default.yml', 'personas/')",
        },
        content: {
          type: "string",
          description: "Content to write or append (required for write/append actions)",
        },
      },
      required: ["action", "path"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;
    const relativePath = input.path as string;
    const content = input.content as string | undefined;

    const fullPath = resolveSafePath(relativePath);
    if (!fullPath) {
      return { error: "Invalid path — must be within ~/.mame/" };
    }

    // Block all access to vault directory
    if (relativePath.includes(".vault") || relativePath.endsWith(".enc")) {
      return { error: "Cannot access vault directory. Use the secrets CLI: mame secrets list" };
    }

    switch (action) {
      case "list": {
        if (!fs.existsSync(fullPath)) {
          return { error: `Directory not found: ${relativePath}` };
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
          return { error: `Not a directory: ${relativePath}` };
        }
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        return {
          path: relativePath,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
            size: e.isFile() ? fs.statSync(path.join(fullPath, e.name)).size : undefined,
          })),
        };
      }

      case "read": {
        if (!fs.existsSync(fullPath)) {
          return { error: `File not found: ${relativePath}` };
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          return { error: `Is a directory, not a file. Use action 'list' instead.` };
        }
        // Don't read binary files
        if (relativePath.endsWith(".db") || relativePath.endsWith(".db-wal") || relativePath.endsWith(".db-shm")) {
          return { error: "Cannot read binary database files. Use the memory tool to query memories." };
        }
        const text = fs.readFileSync(fullPath, "utf-8");
        return { path: relativePath, content: text, size: text.length };
      }

      case "write": {
        if (!content && content !== "") {
          return { error: "content required for write action" };
        }
        if (isReadOnly(relativePath)) {
          return { error: `Cannot write to ${relativePath} — use the appropriate tool (vault for secrets)` };
        }
        const writeErr = validateStructuredContent(relativePath, content);
        if (writeErr) return { error: writeErr };
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return { written: true, path: relativePath, size: content.length };
      }

      case "append": {
        if (!content) {
          return { error: "content required for append action" };
        }
        if (isReadOnly(relativePath)) {
          return { error: `Cannot write to ${relativePath} — use the appropriate tool (vault for secrets)` };
        }
        if (!fs.existsSync(fullPath)) {
          return { error: `File not found: ${relativePath}. Use 'write' to create new files.` };
        }
        // For structured files, validate the final result (existing + appended)
        if (relativePath.endsWith(".yml") || relativePath.endsWith(".yaml") || relativePath.endsWith(".json")) {
          const existing = fs.readFileSync(fullPath, "utf-8");
          const merged = existing + content;
          const appendErr = validateStructuredContent(relativePath, merged);
          if (appendErr) return { error: appendErr };
        }
        fs.appendFileSync(fullPath, content);
        return { appended: true, path: relativePath, bytesAdded: content.length };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  },
});
