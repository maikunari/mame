// src/tools/x.ts — X (Twitter) bookmarks_fetch tool

import { registerTool, type ToolContext } from "./index.js";
import { Vault } from "../vault.js";
import { getValidToken } from "../x-auth.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:x");
const X_API = "https://api.x.com/2";

interface BookmarkItem {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  entities?: {
    urls?: Array<{ expanded_url: string; display_url?: string; title?: string }>;
  };
}

interface XApiResponse<T> {
  data?: T;
  meta?: { next_token?: string; result_count?: number };
}

interface XError {
  status?: number;
}

async function xFetch(urlPath: string, token: string): Promise<unknown> {
  const res = await fetch(`${X_API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err: Error & XError = new Error(`X API error (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

function formatBookmark(item: BookmarkItem) {
  // Prefer the first URL that isn't a t.co shortlink — that's the actual article
  const urls = item.entities?.urls ?? [];
  const articleUrl = urls.find((u) => !u.expanded_url.startsWith("https://t.co/")) ?? urls[0];
  return {
    id: item.id,
    text: item.text,
    sourceUrl: `https://x.com/i/web/status/${item.id}`,
    linkedUrl: articleUrl?.expanded_url ?? null,
    linkedTitle: articleUrl?.title ?? null,
    savedAt: item.created_at ?? null,
  };
}

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

    const meData = await xFetch(
      "/users/me?user.fields=id,username",
      token
    ) as XApiResponse<{ id: string; username: string }>;

    if (!meData.data) return { error: "Failed to get authenticated user from X API" };
    const { id: userId, username } = meData.data;

    if (action === "folders") {
      const data = await xFetch(
        `/users/${userId}/bookmarks/folders`,
        token
      ) as XApiResponse<Array<{ id: string; name: string }>>;

      return {
        userId,
        username,
        folders: (data.data ?? []).map((f) => ({ id: f.id, name: f.name })),
      };
    }

    if (action === "list") {
      const params = new URLSearchParams({
        max_results: String(limit),
        "tweet.fields": "created_at,entities,author_id,text",
      });

      const data = await xFetch(
        `/users/${userId}/bookmarks?${params}`,
        token
      ) as XApiResponse<BookmarkItem[]>;

      const bookmarks = (data.data ?? []).map(formatBookmark);
      log.info({ count: bookmarks.length, username }, "bookmarks_fetch list");
      return {
        userId,
        username,
        count: bookmarks.length,
        bookmarks,
        nextToken: data.meta?.next_token ?? null,
      };
    }

    if (action === "by_folder") {
      if (!folderName) return { error: "folder is required for action=by_folder" };

      const foldersData = await xFetch(
        `/users/${userId}/bookmarks/folders`,
        token
      ) as XApiResponse<Array<{ id: string; name: string }>>;

      const folders = foldersData.data ?? [];
      const match = folders.find(
        (f) => f.name.toLowerCase() === folderName.toLowerCase()
      );

      if (!match) {
        return {
          error: `Folder "${folderName}" not found`,
          availableFolders: folders.map((f) => f.name),
        };
      }

      const params = new URLSearchParams({
        max_results: String(limit),
        "tweet.fields": "created_at,entities,author_id,text",
      });

      const data = await xFetch(
        `/users/${userId}/bookmarks/folders/${match.id}/bookmarks?${params}`,
        token
      ) as XApiResponse<BookmarkItem[]>;

      const bookmarks = (data.data ?? []).map(formatBookmark);
      log.info({ count: bookmarks.length, folder: match.name, username }, "bookmarks_fetch by_folder");
      return {
        userId,
        username,
        folder: match.name,
        folderId: match.id,
        count: bookmarks.length,
        bookmarks,
        nextToken: data.meta?.next_token ?? null,
      };
    }

    return { error: `Unknown action: ${action}` };
  },
});
