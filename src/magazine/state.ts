// src/magazine/state.ts — Magazine state + archive persistence.
//
// Two stores:
//   1. state.json  — small JSON file with { lastSyncedBookmarkId, oldGoldResurfaceLog }.
//                    Mutated on every ingest run.
//   2. archive/bookmarks.db — sqlite, append-only-ish history of every bookmark
//                    we've ever seen. Used to pick Old Gold candidates from
//                    the long tail.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { MAME_HOME } from "../config.js";
import { childLogger } from "../logger.js";

const log = childLogger("magazine:state");

export const MAGAZINE_DIR = path.join(MAME_HOME, "magazine");
export const RAW_DIR = path.join(MAGAZINE_DIR, "raw");
export const ISSUES_DIR = path.join(MAGAZINE_DIR, "issues");
export const PUBLIC_DIR = path.join(MAGAZINE_DIR, "public");
export const ARCHIVE_DIR = path.join(MAGAZINE_DIR, "archive");
const STATE_FILE = path.join(MAGAZINE_DIR, "state.json");
const ARCHIVE_DB = path.join(ARCHIVE_DIR, "bookmarks.db");

export interface MagazineState {
  /** Newest bookmark ID we've ingested. Used to short-circuit pagination. */
  lastSyncedBookmarkId: string | null;
  /** Per-bookmark resurface history — ISO date of last time we featured it as Old Gold. */
  oldGoldResurfaceLog: Record<string, string>;
  /** Monotonically increasing issue counter for the masthead. */
  nextIssueNumber: number;
}

const DEFAULT_STATE: MagazineState = {
  lastSyncedBookmarkId: null,
  oldGoldResurfaceLog: {},
  nextIssueNumber: 1,
};

function ensureDirs(): void {
  for (const dir of [MAGAZINE_DIR, RAW_DIR, ISSUES_DIR, PUBLIC_DIR, ARCHIVE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadState(): MagazineState {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MagazineState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    log.warn({ err: String(err) }, "Could not parse state.json — using defaults");
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: MagazineState): void {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Archive db — every bookmark we've ever seen, plus optional fetched excerpt.
// Single-table sqlite. Indices on saved_at + folder for Old Gold queries.
// ---------------------------------------------------------------------------

export interface ArchivedBookmark {
  id: string;
  text: string;
  source_url: string;
  linked_url: string | null;
  linked_title: string | null;
  linked_description: string | null;
  saved_at: string | null;
  folder: string | null;
  ingested_at: string;
  article_excerpt: string | null;
  hero_image: string | null;
}

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  ensureDirs();
  const db = new Database(ARCHIVE_DB);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source_url TEXT NOT NULL,
      linked_url TEXT,
      linked_title TEXT,
      linked_description TEXT,
      saved_at TEXT,
      folder TEXT,
      ingested_at TEXT NOT NULL,
      article_excerpt TEXT,
      hero_image TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_saved_at ON bookmarks(saved_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder);
  `);

  // Idempotent migration: earlier archives don't have hero_image. Add the
  // column if missing — ignore the error if it already exists.
  try {
    db.exec("ALTER TABLE bookmarks ADD COLUMN hero_image TEXT");
  } catch (err) {
    // column already exists — expected on fresh installs, ignore
  }

  dbInstance = db;
  return db;
}

export function upsertArchive(items: ArchivedBookmark[]): { inserted: number; updated: number } {
  if (items.length === 0) return { inserted: 0, updated: 0 };
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO bookmarks (id, text, source_url, linked_url, linked_title, linked_description, saved_at, folder, ingested_at, article_excerpt, hero_image)
    VALUES (@id, @text, @source_url, @linked_url, @linked_title, @linked_description, @saved_at, @folder, @ingested_at, @article_excerpt, @hero_image)
    ON CONFLICT(id) DO UPDATE SET
      folder = COALESCE(excluded.folder, folder),
      linked_title = COALESCE(excluded.linked_title, linked_title),
      linked_description = COALESCE(excluded.linked_description, linked_description),
      article_excerpt = COALESCE(excluded.article_excerpt, article_excerpt),
      hero_image = COALESCE(excluded.hero_image, hero_image)
  `);

  let inserted = 0;
  let updated = 0;
  const tx = db.transaction((rows: ArchivedBookmark[]) => {
    for (const row of rows) {
      const exists = db.prepare("SELECT 1 FROM bookmarks WHERE id = ?").get(row.id);
      insert.run(row);
      if (exists) updated++;
      else inserted++;
    }
  });
  tx(items);
  return { inserted, updated };
}

/**
 * Pick Old Gold candidates: bookmarks at least 30 days old, NOT already in
 * `excludeIds` (today's items), and either never resurfaced OR not resurfaced
 * in the last 90 days. Returns up to `limit` rows in random order.
 */
export function pickOldGoldCandidates(
  excludeIds: string[],
  resurfaceLog: Record<string, string>,
  limit: number = 20
): ArchivedBookmark[] {
  const db = getDb();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

  const recentlyResurfaced = Object.entries(resurfaceLog)
    .filter(([, when]) => when > ninetyDaysAgo)
    .map(([id]) => id);

  const blockedIds = new Set([...excludeIds, ...recentlyResurfaced]);
  const blockedList = [...blockedIds];

  // sqlite parameter list for NOT IN — bound positionally
  const placeholders = blockedList.map(() => "?").join(",");
  const whereNotIn = blockedList.length > 0 ? `AND id NOT IN (${placeholders})` : "";

  const stmt = db.prepare(`
    SELECT id, text, source_url, linked_url, linked_title, linked_description,
           saved_at, folder, ingested_at, article_excerpt, hero_image
    FROM bookmarks
    WHERE saved_at IS NOT NULL
      AND saved_at < ?
      ${whereNotIn}
    ORDER BY RANDOM()
    LIMIT ?
  `);

  return stmt.all(thirtyDaysAgo, ...blockedList, limit) as ArchivedBookmark[];
}

/** For diagnostics. */
export function archiveStats(): { total: number; oldest: string | null; newest: string | null } {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as total, MIN(saved_at) as oldest, MAX(saved_at) as newest FROM bookmarks")
    .get() as { total: number; oldest: string | null; newest: string | null };
  return row;
}

export function rawJsonlPath(date: string): string {
  return path.join(RAW_DIR, `bookmarks-${date}.jsonl`);
}

export function issueJsonPath(date: string): string {
  return path.join(ISSUES_DIR, `${date}.json`);
}

export function todayISO(timezone: string): string {
  // YYYY-MM-DD in the given timezone (default Asia/Tokyo)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
