// src/x-bookmarks.ts — Programmatic X (Twitter) bookmarks API helpers.
//
// Used by both the LLM-facing bookmarks_fetch tool (src/tools/x.ts) and the
// magazine ingest pipeline (src/magazine/ingest.ts). Auth is handled by
// x-auth.ts — callers pass a valid bearer token.

const X_API = "https://api.x.com/2";

export interface XApiError extends Error {
  status?: number;
}

export interface XBookmarkRaw {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  entities?: {
    urls?: Array<{
      url?: string;
      expanded_url: string;
      display_url?: string;
      title?: string;
      description?: string;
      unwound_url?: string;
      media_key?: string;
    }>;
  };
}

export interface XApiResponse<T> {
  data?: T;
  meta?: { next_token?: string; result_count?: number };
}

export interface XFolder {
  id: string;
  name: string;
}

/** A formatted bookmark for downstream consumers. Drops X's noise. */
export interface FormattedBookmark {
  id: string;
  text: string;
  sourceUrl: string;
  linkedUrl: string | null;
  linkedTitle: string | null;
  linkedDescription: string | null;
  savedAt: string | null;
}

export async function xFetch<T = unknown>(urlPath: string, token: string): Promise<T> {
  const res = await fetch(`${X_API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    const err: XApiError = new Error(`X API error (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export async function getMe(token: string): Promise<{ id: string; username: string }> {
  const data = await xFetch<XApiResponse<{ id: string; username: string }>>(
    "/users/me?user.fields=id,username",
    token
  );
  if (!data.data) throw new Error("X /users/me returned no data");
  return data.data;
}

export async function listFolders(userId: string, token: string): Promise<XFolder[]> {
  const data = await xFetch<XApiResponse<XFolder[]>>(
    `/users/${userId}/bookmarks/folders`,
    token
  );
  return data.data ?? [];
}

interface ListBookmarksOpts {
  limit?: number;            // max per request (5-100, default 100)
  paginationToken?: string;
}

/**
 * Fetch one page of bookmarks. Returns raw items + a next_token for pagination.
 * Bookmarks are returned newest-first.
 */
export async function listBookmarksPage(
  userId: string,
  token: string,
  opts: ListBookmarksOpts = {}
): Promise<{ items: XBookmarkRaw[]; nextToken: string | null }> {
  const params = new URLSearchParams({
    max_results: String(opts.limit ?? 100),
    "tweet.fields": "created_at,entities,author_id,text",
  });
  if (opts.paginationToken) params.set("pagination_token", opts.paginationToken);

  const data = await xFetch<XApiResponse<XBookmarkRaw[]>>(
    `/users/${userId}/bookmarks?${params}`,
    token
  );
  return { items: data.data ?? [], nextToken: data.meta?.next_token ?? null };
}

/**
 * Same as listBookmarksPage but scoped to a folder.
 */
export async function listFolderBookmarksPage(
  userId: string,
  folderId: string,
  token: string,
  opts: ListBookmarksOpts = {}
): Promise<{ items: XBookmarkRaw[]; nextToken: string | null }> {
  const params = new URLSearchParams({
    max_results: String(opts.limit ?? 100),
    "tweet.fields": "created_at,entities,author_id,text",
  });
  if (opts.paginationToken) params.set("pagination_token", opts.paginationToken);

  const data = await xFetch<XApiResponse<XBookmarkRaw[]>>(
    `/users/${userId}/bookmarks/folders/${folderId}/bookmarks?${params}`,
    token
  );
  return { items: data.data ?? [], nextToken: data.meta?.next_token ?? null };
}

/**
 * Pick the best linked URL from a bookmark's entities. Skips:
 *   - t.co shortlinks (always wrapped — never the real URL)
 *   - x.com / twitter.com media URLs (photo/video pages, not articles)
 *   - pic.x.com / pic.twitter.com
 * Prefers `unwound_url` (X has resolved redirects) over `expanded_url`.
 */
function pickArticleUrl(urls: NonNullable<XBookmarkRaw["entities"]>["urls"] = []) {
  for (const u of urls) {
    if (u.media_key) continue; // media attachment, not an article
    const candidate = u.unwound_url ?? u.expanded_url;
    if (!candidate) continue;
    if (candidate.startsWith("https://t.co/")) continue;
    if (/^https?:\/\/(pic\.)?(x|twitter)\.com\/.+\/(photo|video)\//.test(candidate)) continue;
    if (/^https?:\/\/pic\.(x|twitter)\.com\//.test(candidate)) continue;
    return u;
  }
  return null;
}

export function formatBookmark(item: XBookmarkRaw): FormattedBookmark {
  const article = pickArticleUrl(item.entities?.urls);
  return {
    id: item.id,
    text: item.text,
    sourceUrl: `https://x.com/i/web/status/${item.id}`,
    linkedUrl: article ? (article.unwound_url ?? article.expanded_url) : null,
    linkedTitle: article?.title ?? null,
    linkedDescription: article?.description ?? null,
    savedAt: item.created_at ?? null,
  };
}
