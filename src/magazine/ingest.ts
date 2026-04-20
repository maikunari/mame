// src/magazine/ingest.ts — Pull new X bookmarks, resolve linked URLs, persist
// to today's raw JSONL + the long-term archive db.
//
// Flow:
//   1. Get auth token from vault.
//   2. List the user's bookmark folders.
//   3. For each folder, paginate bookmarks newest-first until we hit
//      lastSyncedBookmarkId (or run out).
//   4. Optionally also walk the flat bookmark stream so we capture items not
//      in any folder (un-foldered items still belong in the archive).
//   5. For each new bookmark with a real linked URL, do a plain fetch() with
//      a 15s timeout and stash a stripped excerpt. Skips media URLs.
//   6. Write all new items to today's JSONL and upsert into the archive.
//   7. Update state.json with the newest bookmark ID seen.

import fs from "fs";
import { Vault } from "../vault.js";
import { getValidToken } from "../x-auth.js";
import {
  formatBookmark,
  getMe,
  listBookmarksPage,
  listFolderBookmarksPage,
  listFolders,
  type FormattedBookmark,
  type XFolder,
} from "../x-bookmarks.js";
import {
  loadState,
  saveState,
  upsertArchive,
  rawJsonlPath,
  todayISO,
  type ArchivedBookmark,
} from "./state.js";
import { loadConfig } from "../config.js";
import { childLogger } from "../logger.js";

const log = childLogger("magazine:ingest");

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CONCURRENCY = 5;
const MAX_PAGES_PER_FOLDER = 5; // safety cap — at 100/page that's 500 bookmarks

export interface IngestRecord {
  id: string;
  source: "x";
  sourceUrl: string;
  text: string;
  linkedUrl: string | null;
  linkedTitle: string | null;
  linkedDescription: string | null;
  savedAt: string | null;
  folder: string | null;
  articleExcerpt: string | null;
  /** OG/twitter image scraped from the linked article, or the tweet's
   * own media attachment as a fallback. Null when neither is available. */
  heroImage: string | null;
}

export interface IngestResult {
  date: string;
  newCount: number;
  totalScanned: number;
  byFolder: Record<string, number>;
  rawFile: string;
  newestId: string | null;
}

/**
 * Run an ingest pass. Returns a summary and writes today's JSONL + archive.
 */
export async function runIngest(date?: string): Promise<IngestResult> {
  const cfg = loadConfig();
  const today = date ?? todayISO(cfg.timezone);
  log.info({ date: today }, "ingest run starting");

  const vault = new Vault();
  const token = await getValidToken(vault);
  const me = await getMe(token);

  const state = loadState();
  const stopAtId = state.lastSyncedBookmarkId;

  // Folders are a Premium-only X feature. If the endpoint 404s (or any error),
  // gracefully fall back to flat-stream-only ingest.
  let folders: XFolder[] = [];
  try {
    folders = await listFolders(me.id, token);
    log.info({ folders: folders.map((f) => f.name) }, "found folders");
  } catch (err) {
    log.warn({ err: String(err) }, "folders endpoint failed (Premium feature?) — falling back to flat stream only");
  }

  type Collected = FormattedBookmark & { folder: string | null };
  const collected = new Map<string, Collected>();
  const byFolder: Record<string, number> = {};
  let totalScanned = 0;

  // Per-folder walk (skipped if folders unavailable)
  for (const folder of folders) {
    try {
      const { count, scanned } = await walkFolder(me.id, token, folder, stopAtId, (b) => {
        if (!collected.has(b.id)) collected.set(b.id, { ...b, folder: folder.name });
      });
      byFolder[folder.name] = count;
      totalScanned += scanned;
    } catch (err) {
      log.warn({ folder: folder.name, err: String(err) }, "folder walk failed — skipping this folder");
    }
  }

  // Flat stream — captures un-foldered items
  const flatScanned = await walkFlat(me.id, token, stopAtId, (b) => {
    if (!collected.has(b.id)) {
      collected.set(b.id, { ...b, folder: null });
      byFolder["(unfiled)"] = (byFolder["(unfiled)"] ?? 0) + 1;
    }
  });
  totalScanned += flatScanned;

  log.info({ collected: collected.size, totalScanned }, "bookmark walk complete");

  // Resolve linked URLs (excerpt + og:image) in parallel
  const all = [...collected.values()];
  const records: IngestRecord[] = [];
  await mapWithConcurrency(all, FETCH_CONCURRENCY, async (b) => {
    const fetched = b.linkedUrl ? await fetchArticlePayload(b.linkedUrl) : null;
    // Prefer the article's og:image; fall back to tweet media attachment.
    const heroImage = fetched?.image ?? b.tweetImage ?? null;
    records.push({
      id: b.id,
      source: "x",
      sourceUrl: b.sourceUrl,
      text: b.text,
      linkedUrl: b.linkedUrl,
      linkedTitle: b.linkedTitle,
      linkedDescription: b.linkedDescription,
      savedAt: b.savedAt,
      folder: b.folder,
      articleExcerpt: fetched?.excerpt ?? null,
      heroImage,
    });
  });

  // Persist: JSONL (today), archive (forever), state (lastSyncedId)
  if (records.length > 0) {
    appendJsonl(rawJsonlPath(today), records);

    const ingestedAt = new Date().toISOString();
    const archiveRows: ArchivedBookmark[] = records.map((r) => ({
      id: r.id,
      text: r.text,
      source_url: r.sourceUrl,
      linked_url: r.linkedUrl,
      linked_title: r.linkedTitle,
      linked_description: r.linkedDescription,
      saved_at: r.savedAt,
      folder: r.folder,
      ingested_at: ingestedAt,
      article_excerpt: r.articleExcerpt,
      hero_image: r.heroImage,
    }));
    const { inserted, updated } = upsertArchive(archiveRows);
    log.info({ inserted, updated }, "archive upserted");
  }

  // newest = lexicographically max by snowflake ID (numeric strings sort right at equal length)
  const newestId = newestSnowflake([...collected.keys(), state.lastSyncedBookmarkId].filter(Boolean) as string[]);
  if (newestId !== state.lastSyncedBookmarkId) {
    state.lastSyncedBookmarkId = newestId;
    saveState(state);
  }

  return {
    date: today,
    newCount: records.length,
    totalScanned,
    byFolder,
    rawFile: rawJsonlPath(today),
    newestId,
  };
}

// ---------------------------------------------------------------------------
// Folder + flat walkers — paginate until we hit stopAtId or run out.
// ---------------------------------------------------------------------------

async function walkFolder(
  userId: string,
  token: string,
  folder: XFolder,
  stopAtId: string | null,
  onItem: (b: FormattedBookmark) => void
): Promise<{ count: number; scanned: number }> {
  let nextToken: string | null = null;
  let pages = 0;
  let count = 0;
  let scanned = 0;
  do {
    const page = await listFolderBookmarksPage(userId, folder.id, token, {
      limit: 100,
      paginationToken: nextToken ?? undefined,
    });
    for (const item of page.items) {
      scanned++;
      if (stopAtId && compareSnowflake(item.id, stopAtId) <= 0) {
        return { count, scanned };
      }
      onItem(formatBookmark(item, page.media));
      count++;
    }
    nextToken = page.nextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES_PER_FOLDER);
  return { count, scanned };
}

async function walkFlat(
  userId: string,
  token: string,
  stopAtId: string | null,
  onItem: (b: FormattedBookmark) => void
): Promise<number> {
  let nextToken: string | null = null;
  let pages = 0;
  let scanned = 0;
  do {
    const page = await listBookmarksPage(userId, token, {
      limit: 100,
      paginationToken: nextToken ?? undefined,
    });
    for (const item of page.items) {
      scanned++;
      if (stopAtId && compareSnowflake(item.id, stopAtId) <= 0) {
        return scanned;
      }
      onItem(formatBookmark(item, page.media));
    }
    nextToken = page.nextToken;
    pages++;
  } while (nextToken && pages < MAX_PAGES_PER_FOLDER);
  return scanned;
}

// ---------------------------------------------------------------------------
// Article fetch — plain HTTP. Returns both a stripped excerpt (for the LLM
// summarizer) and an og:image URL (for the magazine hero). Skips on
// timeout/error and lets the digest fall back to text + tweet media.
// ---------------------------------------------------------------------------

interface ArticlePayload {
  excerpt: string | null;
  image: string | null;
}

async function fetchArticlePayload(url: string): Promise<ArticlePayload> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Mame-dAIly-digest/0.1)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { excerpt: null, image: null };
    const html = await res.text();
    const image = extractOgImage(html, url);
    const excerpt = stripHtml(html).slice(0, 4000);
    return { excerpt, image };
  } catch (err) {
    log.debug({ url, err: String(err) }, "article fetch failed");
    return { excerpt: null, image: null };
  }
}

/**
 * Pull og:image / twitter:image / link rel=image_src from HTML head, in
 * that order of preference. Resolves relative URLs against pageUrl.
 */
function extractOgImage(html: string, pageUrl: string): string | null {
  // Only look at the first ~16kb — metatags live in <head>
  const head = html.slice(0, 16_384);
  const patterns: RegExp[] = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const rx of patterns) {
    const m = head.match(rx);
    if (m?.[1]) return resolveUrl(m[1], pageUrl);
  }
  return null;
}

function resolveUrl(candidate: string, base: string): string | null {
  try {
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function appendJsonl(filePath: string, items: IngestRecord[]): void {
  const out = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
  fs.appendFileSync(filePath, out, "utf-8");
}

/** Snowflake comparator — IDs are numeric strings, so length-then-lex works. */
function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function newestSnowflake(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return ids.reduce((acc, id) => (compareSnowflake(id, acc) > 0 ? id : acc));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) return;
          await worker(next);
        }
      })()
    );
  }
  await Promise.all(runners);
}
