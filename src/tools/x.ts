// src/tools/x.ts — X (Twitter) bookmarks_fetch tool
//
// Thin LLM-facing wrapper around src/x-bookmarks.ts. The same helpers are
// also called programmatically from src/magazine/ingest.ts.

import { registerTool, type ToolContext } from "./index.js";
import { Vault } from "../vault.js";
import { getValidToken } from "../x-auth.js";
import {
  formatBookmark,
  getMe,
  listBookmarksPage,
  listFolders,
  listFolderBookmarksPage,
} from "../x-bookmarks.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:x");

registerTool({
  definition: {
    name: "bookmarks_fetch",
    description:
      "Fetch Mike's X (Twitter) bookmarks. action=list returns recent bookmarks flat; action=by_folder returns bookmarks from a named folder; action=folders lists available folder names. Requires prior 'mame x auth'.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "by_folder", "folders"],
          description: "list = all recent bookmarks; by_folder = bookmarks in a specific folder; folders = list available folder names",
        },
        folder: {
          type: "string",
          description: "Folder name — required for action=by_folder",
        },
        limit: {
          type: "number",
          description: "Max bookmarks to return (default 20, max 100)",
        },
      },
      required: ["action"],
    },
  },

  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;
    const folderName = input.folder as string | undefined;
    const limit = Math.min((input.limit as number | undefined) ?? 20, 100);

    const vault = new Vault();
    const token = await getValidToken(vault);

    const me = await getMe(token);

    if (action === "folders") {
      const folders = await listFolders(me.id, token);
      return { userId: me.id, username: me.username, folders };
    }

    if (action === "list") {
      const { items, media, nextToken } = await listBookmarksPage(me.id, token, { limit });
      const bookmarks = items.map((i) => formatBookmark(i, media));
      log.info({ count: bookmarks.length, username: me.username }, "bookmarks_fetch list");
      return {
        userId: me.id,
        username: me.username,
        count: bookmarks.length,
        bookmarks,
        nextToken,
      };
    }

    if (action === "by_folder") {
      if (!folderName) return { error: "folder is required for action=by_folder" };

      const folders = await listFolders(me.id, token);
      const match = folders.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
      if (!match) {
        return {
          error: `Folder "${folderName}" not found`,
          availableFolders: folders.map((f) => f.name),
        };
      }

      const { items, media, nextToken } = await listFolderBookmarksPage(me.id, match.id, token, { limit });
      const bookmarks = items.map((i) => formatBookmark(i, media));
      log.info({ count: bookmarks.length, folder: match.name }, "bookmarks_fetch by_folder");
      return {
        userId: me.id,
        username: me.username,
        folder: match.name,
        folderId: match.id,
        count: bookmarks.length,
        bookmarks,
        nextToken,
      };
    }

    return { error: `Unknown action: ${action}` };
  },
});
