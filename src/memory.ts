// src/memory.ts — SQLite + FTS5 memory (~50 lines per spec)

import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MAME_HOME } from "./config.js";

// Ensure ~/.mame/ exists before opening the database
fs.mkdirSync(MAME_HOME, { recursive: true });

const dbPath = path.join(MAME_HOME, "memory.db");
const db: DatabaseType = new Database(dbPath);

// Set file permissions to owner-only (0600)
try { fs.chmodSync(dbPath, 0o600); } catch { /* may fail on some systems */ }

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Schema — one table, one FTS5 index with content= auto-sync
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    project TEXT,
    category TEXT DEFAULT 'general',
    importance REAL DEFAULT 0.5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed DATETIME,
    access_count INTEGER DEFAULT 0
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, project, category, content=memories, content_rowid=id);

  -- Triggers to keep FTS5 in sync with the memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, project, category)
    VALUES (new.id, new.content, new.project, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, project, category)
    VALUES ('delete', old.id, old.content, old.project, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, project, category)
    VALUES ('delete', old.id, old.content, old.project, old.category);
    INSERT INTO memories_fts(rowid, content, project, category)
    VALUES (new.id, new.content, new.project, new.category);
  END;
`);

export interface Memory {
  id: number;
  content: string;
  project: string | null;
  category: string;
  importance: number;
  created_at: string;
  last_accessed: string | null;
  access_count: number;
}

// ---------------------------------------------------------------------------
// Timestamp formatting — converts UTC timestamps from SQLite into a format
// the model and the user can reason about without doing timezone math.
//
// Output looks like: "2026-04-08T12:12:44+09:00 JST (3 hours ago)"
//
// Why all three formats in one string:
// - ISO 8601 with offset: unambiguous, machine-parseable, no guessing
// - Timezone abbreviation: human-readable anchor (JST / EST / etc)
// - Relative time: the model's favorite form for reasoning about recency
//
// Addressing a real pain point: models struggle repeatedly with implicit
// timezone reasoning, especially across multi-timezone work (mike in JST
// doing business with people in EST). Making the timezone explicit at the
// display layer — while keeping storage in UTC — gives the model a solid
// anchor to reason from instead of having to guess what "2026-04-08
// 03:12:44" refers to.
// ---------------------------------------------------------------------------

// Fallback timezone → abbreviation map for IANA zones that Node's Intl
// returns as "GMT+9" instead of a real code. Covers the zones the user
// actually works in across their business day. Others fall through to
// the numeric offset (e.g. "+05:30" for Asia/Kolkata) which is still
// unambiguous, just less friendly.
const TIMEZONE_ABBREV_FALLBACK: Record<string, string> = {
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Asia/Shanghai": "CST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Singapore": "SGT",
  "Asia/Kolkata": "IST",
  "Europe/London": "BST", // defaults to BST; winter is GMT — Intl usually handles this correctly
  "Europe/Paris": "CET",
  "Europe/Berlin": "CET",
  "Australia/Sydney": "AEDT",
  "Pacific/Auckland": "NZDT",
};

/**
 * Convert a SQLite UTC timestamp (as stored by CURRENT_TIMESTAMP) into a
 * rich, timezone-explicit display string.
 *
 * @param sqliteTimestamp - The raw value from `created_at` / `last_accessed`.
 *                          SQLite returns these in the form "2026-04-08 03:12:44"
 *                          which is naked UTC with no timezone marker.
 * @param timezone - IANA timezone name (e.g. "Asia/Tokyo"). Usually comes
 *                   from the persona / config.
 * @param now - The reference point for the relative time suffix. Defaults
 *              to Date.now() but is injectable for tests.
 * @returns e.g. "2026-04-08T12:12:44+09:00 JST (3 hours ago)"
 */
export function formatMemoryTimestamp(
  sqliteTimestamp: string,
  timezone: string,
  now: Date = new Date()
): string {
  // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC without
  // a Z suffix. Parse it as UTC by appending Z.
  const stored = new Date(sqliteTimestamp.replace(" ", "T") + "Z");
  if (isNaN(stored.getTime())) {
    // Defensive — if the timestamp isn't parseable, return it as-is rather
    // than crashing the memory tool.
    return sqliteTimestamp;
  }

  // Extract year/month/day/hour/minute/second in the target timezone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(stored);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value || "";

  const datePart = `${get("year")}-${get("month")}-${get("day")}`;
  // Intl returns "24" for midnight instead of "00" in some environments;
  // normalize that so the string stays ISO-valid.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const timePart = `${hour}:${get("minute")}:${get("second")}`;

  // Compute the offset via Intl's longOffset format — returns "GMT+09:00"
  // or "GMT-04:00". Strip the GMT prefix to get a plain ISO-style offset.
  // This is much more reliable than round-tripping through toLocaleString,
  // which re-parses in the system's local timezone and produces garbage.
  let offset = "+00:00";
  try {
    const offsetParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(stored);
    const raw = offsetParts.find((p) => p.type === "timeZoneName")?.value || "";
    const match = raw.match(/GMT([+-]\d{2}:\d{2})/);
    if (match) offset = match[1];
    else if (raw === "GMT") offset = "+00:00";
  } catch {
    /* fall through to +00:00 */
  }

  // Short timezone label — "JST", "EDT", "PDT", etc. via Intl's short form.
  // Some IANA zones don't have a common abbreviation in Node's Intl and
  // return "GMT+9" instead (Asia/Tokyo is one such case depending on the
  // ICU data version). We only include the label if Intl gave us a real
  // letter-only code; otherwise we fall back to a small hand-rolled map
  // of timezones the user actually works in.
  let tzAbbrev = "";
  try {
    const tzParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(stored);
    const raw = tzParts.find((p) => p.type === "timeZoneName")?.value || "";
    if (/^[A-Z]{2,5}$/.test(raw)) {
      tzAbbrev = raw;
    }
  } catch {
    /* ignore */
  }
  if (!tzAbbrev) {
    tzAbbrev = TIMEZONE_ABBREV_FALLBACK[timezone] || "";
  }

  const iso = `${datePart}T${timePart}${offset}`;
  const relative = relativeTime(stored, now);

  if (tzAbbrev) {
    return `${iso} ${tzAbbrev} (${relative})`;
  }
  return `${iso} (${relative})`;
}

/**
 * Render the distance between two dates as a human-readable relative string.
 * Purely arithmetic — no locale or timezone concerns, no external deps.
 */
function relativeTime(from: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds < 0 ? "from now" : "ago";

  if (abs < 45) return "just now";
  if (abs < 90) return `a minute ${suffix}`;
  if (abs < 45 * 60) return `${Math.round(abs / 60)} minutes ${suffix}`;
  if (abs < 90 * 60) return `an hour ${suffix}`;
  if (abs < 22 * 3600) return `${Math.round(abs / 3600)} hours ${suffix}`;
  if (abs < 36 * 3600) return `a day ${suffix}`;
  if (abs < 25 * 86400) return `${Math.round(abs / 86400)} days ${suffix}`;
  if (abs < 45 * 86400) return `a month ${suffix}`;
  if (abs < 320 * 86400) return `${Math.round(abs / (30 * 86400))} months ${suffix}`;
  if (abs < 548 * 86400) return `a year ${suffix}`;
  return `${Math.round(abs / (365 * 86400))} years ${suffix}`;
}

export async function remember(
  content: string,
  project?: string,
  category?: string,
  importance?: number
): Promise<number> {
  const result = db.prepare(
    "INSERT INTO memories (content, project, category, importance) VALUES (?, ?, ?, ?)"
  ).run(content, project || null, category || "general", importance || 0.5);
  return result.lastInsertRowid as number;
}

// Sanitize input for FTS5 — quote each term to avoid syntax errors from special chars
function sanitizeFts5Query(query: string): string {
  // Split into words, wrap each in double quotes to escape FTS5 operators
  const terms = query
    .replace(/[^\w\s]/g, " ")  // Strip punctuation
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.join(" ");
}

export async function recall(
  query: string,
  project?: string,
  limit = 10
): Promise<Memory[]> {
  const ftsQuery = sanitizeFts5Query(query);
  if (!ftsQuery) return []; // No searchable terms

  try {
    const results = db
      .prepare(
        `
      SELECT m.*, rank
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${project ? "AND m.project = ?" : ""}
      ORDER BY rank * 0.6
             + (1.0 / (1 + julianday('now') - julianday(m.created_at))) * 0.2
             + (m.access_count * 0.01) * 0.2
      LIMIT ?
    `
      )
      .all(...(project ? [ftsQuery, project, limit] : [ftsQuery, limit])) as (Memory & { rank: number })[];

    // Update access stats
    const updateStmt = db.prepare(
      "UPDATE memories SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?"
    );
    for (const r of results) {
      updateStmt.run(r.id);
    }

    return results;
  } catch {
    // FTS5 query can fail on empty tables or edge cases — return empty
    return [];
  }
}

export async function forget(id: number): Promise<void> {
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export async function listMemories(
  project?: string,
  limit = 20
): Promise<Memory[]> {
  if (project) {
    return db
      .prepare("SELECT * FROM memories WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .all(project, limit) as Memory[];
  }
  return db
    .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Memory[];
}

export async function memoryStats(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
}> {
  const total = (db.prepare("SELECT COUNT(*) as count FROM memories").get() as any).count;

  const categories = db
    .prepare("SELECT category, COUNT(*) as count FROM memories GROUP BY category")
    .all() as { category: string; count: number }[];

  const projects = db
    .prepare("SELECT COALESCE(project, 'global') as project, COUNT(*) as count FROM memories GROUP BY project")
    .all() as { project: string; count: number }[];

  return {
    total,
    byCategory: Object.fromEntries(categories.map((c) => [c.category, c.count])),
    byProject: Object.fromEntries(projects.map((p) => [p.project, p.count])),
  };
}

export { db };
