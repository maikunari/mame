// src/memory.ts — SQLite + FTS5 + sqlite-vec hybrid memory.
//
// Storage layers:
// - memories: canonical table with content, project, category, timestamps,
//   access count. This is the source of truth.
// - memories_fts: FTS5 virtual table for keyword search, auto-synced from
//   memories via triggers.
// - memories_vec: sqlite-vec virtual table storing 384-dim embeddings
//   from Xenova/all-MiniLM-L6-v2. Rowids match memories.id so we can
//   join back to get content.
//
// Recall path (Evening 5):
// 1. Run FTS5 keyword search on the sanitized query (top ~20 results)
// 2. In parallel, compute query embedding and run vec similarity (top ~20)
// 3. Merge the two ranked lists via Reciprocal Rank Fusion (RRF)
// 4. Apply the existing recency + access_count weights as secondary
//    sort factors
// 5. Return top N
//
// RRF chosen over weighted-sum because it's robust without needing to
// normalize wildly different score scales between BM25 and cosine
// similarity. k=60 is the standard RRF constant from the literature.
//
// Embeddings are computed lazily: writes succeed even if the model isn't
// loaded yet (the embedding goes in async after the row lands). Recall
// falls back to FTS5-only if the embedding model fails to load or the
// query embedding call errors — the fallback is exactly the pre-Evening-5
// behavior so nothing gets worse.

import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import { MAME_HOME } from "./config.js";
import { embed, EMBEDDING_DIMENSIONS } from "./embedding.js";
import { childLogger } from "./logger.js";

const log = childLogger("memory");

// Ensure ~/.mame/ exists before opening the database
fs.mkdirSync(MAME_HOME, { recursive: true });

const dbPath = path.join(MAME_HOME, "memory.db");
const db: DatabaseType = new Database(dbPath);

// Set file permissions to owner-only (0600)
try { fs.chmodSync(dbPath, 0o600); } catch { /* may fail on some systems */ }

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// Load sqlite-vec as a loadable extension. better-sqlite3 supports this
// out of the box via db.loadExtension(). The sqlite-vec npm package
// ships platform-specific binaries that this resolves automatically.
// If loading fails (unlikely — the package ships darwin, linux, and
// windows x64/arm64 binaries), we continue in FTS5-only mode rather
// than crashing the whole memory system.
let vecAvailable = false;
try {
  sqliteVec.load(db);
  vecAvailable = true;
  log.info({ version: (db.prepare("SELECT vec_version() as v").get() as any).v }, "sqlite-vec loaded");
} catch (err) {
  log.warn(
    { err: err instanceof Error ? err.message : String(err) },
    "sqlite-vec failed to load — falling back to FTS5-only recall"
  );
}

// Schema — one canonical table, one FTS5 index with content= auto-sync,
// one vec virtual table keyed by the same rowid. Vec table only created
// if sqlite-vec is available.
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

if (vecAvailable) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
      USING vec0(embedding FLOAT[${EMBEDDING_DIMENSIONS}]);
  `);

  // Trigger to garbage-collect vec entries when memories are deleted.
  // INSERTs are handled explicitly in remember() because we need to
  // compute the embedding asynchronously — a SQLite trigger can't await.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_vec_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_vec WHERE rowid = old.id;
    END;
  `);
}

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
  const id = result.lastInsertRowid as number;

  // Compute and store the embedding. We await this so the memory is
  // immediately searchable by vec similarity — otherwise a quick
  // remember/recall round-trip could miss. ~200ms cost on a hot model.
  //
  // If embedding fails (model not loaded, transformers.js error), we
  // log and continue. The memory is still in FTS5, so recall still
  // works via keyword search.
  //
  // Note: sqlite-vec's vec0 virtual table requires rowids bound as
  // BigInt — binding a JS number gives "Only integers are allowed for
  // primary key values on memories_vec" because better-sqlite3's default
  // number binding hits a sqlite-vec type check.
  if (vecAvailable) {
    try {
      const vec = await embed(content);
      if (vec) {
        db.prepare(
          "INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)"
        ).run(BigInt(id), Buffer.from(vec.buffer));
      }
    } catch (err) {
      log.warn(
        { id, err: err instanceof Error ? err.message : String(err) },
        "Failed to compute embedding for new memory; FTS5-only for this row"
      );
    }
  }

  return id;
}

/**
 * Backfill embeddings for any memories that don't have one yet. Called
 * once from the daemon startup path. Cheap for a small DB (a few
 * hundred memories takes under a minute), no-op for a fully-populated
 * one. Writes are transactional per row so a crash mid-backfill just
 * picks up where it left off next start.
 */
export async function backfillEmbeddings(): Promise<{ backfilled: number }> {
  if (!vecAvailable) return { backfilled: 0 };

  // Find memories with no corresponding vec row
  const missing = db
    .prepare(
      `
    SELECT m.id, m.content
    FROM memories m
    LEFT JOIN memories_vec v ON v.rowid = m.id
    WHERE v.rowid IS NULL
  `
    )
    .all() as { id: number; content: string }[];

  if (missing.length === 0) return { backfilled: 0 };

  log.info({ count: missing.length }, "Backfilling embeddings for existing memories");
  const start = Date.now();

  const insert = db.prepare("INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)");

  let success = 0;
  for (const m of missing) {
    try {
      const vec = await embed(m.content);
      if (vec) {
        // BigInt rowid — see note in remember() for why this cast matters
        insert.run(BigInt(m.id), Buffer.from(vec.buffer));
        success++;
      }
    } catch (err) {
      log.warn(
        { id: m.id, err: err instanceof Error ? err.message : String(err) },
        "Backfill embed failed for memory; skipping"
      );
    }
  }

  log.info(
    { backfilled: success, total: missing.length, elapsed_ms: Date.now() - start },
    "Backfill complete"
  );
  return { backfilled: success };
}

// Common English stopwords and recall-shaped conversational filler. The
// first group is standard; the second group is the "do you remember..." /
// "what did I tell you about..." vocabulary that's semantically loaded
// from the user's perspective but totally useless for FTS5 matching
// (memory bodies never contain "remember", "asked", "yesterday" etc).
//
// Stripping these lets a query like "what do you remember about Tokyo
// weather or Bitcoin I asked about yesterday" collapse down to the
// actually-searchable terms: tokyo, weather, bitcoin.
const FTS_STOPWORDS = new Set([
  // Articles / conjunctions / pronouns
  "a", "about", "after", "all", "am", "an", "and", "any", "are", "as", "at",
  "be", "been", "being", "but", "by", "can", "could", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "had",
  "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more",
  "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on",
  "once", "only", "or", "other", "our", "ours", "out", "over", "own", "same",
  "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "whom",
  "why", "will", "with", "would", "you", "your", "yours", "yourself",
  // Conversational recall words — loaded for humans, noise for FTS5
  "ask", "asked", "asking", "know", "knew", "knows", "mention", "mentioned",
  "recall", "remember", "remembered", "said", "say", "says", "talked",
  "tell", "told", "think", "thought",
  // Vague time references the memory bodies never contain
  "ago", "earlier", "last", "later", "month", "recent", "recently", "today",
  "tomorrow", "week", "weeks", "year", "years", "yesterday",
]);

// Sanitize input for FTS5 — quote each term to avoid syntax errors from
// special chars, drop stopwords, and use OR semantics so a natural-language
// query matches documents containing ANY of the meaningful terms. BM25
// ranking naturally sorts documents matching more terms higher, which is
// exactly the right default for recall: "what do you remember about Tokyo
// weather" should find the Tokyo memory even though it doesn't contain
// all the words from the question.
//
// Previous implementation joined terms with space (implicit AND in FTS5),
// which meant a natural-language query had to match ALL terms verbatim
// and returned empty for anything beyond a single keyword.
function sanitizeFts5Query(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // Strip punctuation
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !FTS_STOPWORDS.has(t))
    .map((t) => `"${t}"`);

  if (terms.length === 0) return "";

  return terms.join(" OR ");
}

// Number of results pulled from each search layer (FTS5 and vec) before
// fusion. Picking more here gives the RRF merge more signal at the cost
// of a slightly larger sort. 20 is plenty for a personal DB.
const CANDIDATE_POOL_SIZE = 20;

// RRF constant from the literature (Cormack et al.). Higher = less
// sensitive to rank position, more uniform weighting.
const RRF_K = 60;

/**
 * Recall memories matching `query`, using a hybrid of:
 * 1. FTS5 keyword search (BM25 ranked, matches exact words/phrases)
 * 2. sqlite-vec cosine similarity (semantic match, finds ideas expressed
 *    in different words)
 *
 * Results are fused via Reciprocal Rank Fusion so both layers contribute
 * without needing to normalize their very different score scales. Recency
 * and access count are applied as secondary tiebreakers via the existing
 * weighted formula.
 *
 * If sqlite-vec isn't available (extension load failed) or the embedding
 * model isn't ready, falls back to FTS5-only — exactly the pre-Evening-5
 * behavior, so recall degrades gracefully instead of erroring.
 */
export async function recall(
  query: string,
  project?: string,
  limit = 10
): Promise<Memory[]> {
  // FTS5 layer — sanitized, OR-joined, stopword-filtered from Evening 4
  const ftsQuery = sanitizeFts5Query(query);

  const ftsHits = ftsQuery ? fts5Search(ftsQuery, project) : [];

  // Vec layer — compute query embedding, search by cosine similarity
  let vecHits: Memory[] = [];
  if (vecAvailable) {
    try {
      const queryVec = await embed(query);
      if (queryVec) {
        vecHits = vecSearch(queryVec, project);
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Vec search failed; continuing with FTS5-only results"
      );
    }
  }

  // If neither layer produced results, nothing to return
  if (ftsHits.length === 0 && vecHits.length === 0) return [];

  // Reciprocal Rank Fusion — for each memory, add up 1/(k+rank) from
  // each layer it appears in. Memories matched by both layers get a
  // strictly higher score than memories matched by just one.
  const fused = new Map<number, { memory: Memory; score: number }>();

  ftsHits.forEach((m, i) => {
    fused.set(m.id, { memory: m, score: 1 / (RRF_K + i) });
  });

  vecHits.forEach((m, i) => {
    const existing = fused.get(m.id);
    const vecScore = 1 / (RRF_K + i);
    if (existing) {
      existing.score += vecScore;
    } else {
      fused.set(m.id, { memory: m, score: vecScore });
    }
  });

  // Apply recency + access count as secondary factors to the fused
  // score. Keeps the Evening 4 ranking intuition while letting RRF do
  // the heavy lifting for relevance.
  const now = Date.now();
  const rescored = Array.from(fused.values()).map(({ memory, score }) => {
    const ageDays =
      (now - new Date(memory.created_at.replace(" ", "T") + "Z").getTime()) /
      86_400_000;
    const recencyBoost = 1.0 / (1 + ageDays) * 0.01; // tiny — just a tiebreaker
    const accessBoost = memory.access_count * 0.0005;
    return {
      memory,
      finalScore: score + recencyBoost + accessBoost,
    };
  });

  const top = rescored
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit)
    .map((r) => r.memory);

  // Update access stats for everything we returned
  const updateStmt = db.prepare(
    "UPDATE memories SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?"
  );
  for (const m of top) {
    updateStmt.run(m.id);
  }

  return top;
}

function fts5Search(ftsQuery: string, project?: string): Memory[] {
  try {
    return db
      .prepare(
        `
      SELECT m.*
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${project ? "AND m.project = ?" : ""}
      ORDER BY rank
      LIMIT ?
    `
      )
      .all(
        ...(project
          ? [ftsQuery, project, CANDIDATE_POOL_SIZE]
          : [ftsQuery, CANDIDATE_POOL_SIZE])
      ) as Memory[];
  } catch {
    // FTS5 can fail on malformed queries or empty tables — return nothing
    return [];
  }
}

function vecSearch(queryVec: Float32Array, project?: string): Memory[] {
  try {
    // sqlite-vec MATCH requires a subquery pattern with a k limit in the
    // WHERE clause. The join gets us back to the canonical row data.
    const rows = db
      .prepare(
        `
      SELECT m.*, vec_distance_L2(v.embedding, ?) as distance
      FROM memories_vec v
      JOIN memories m ON m.id = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
      ${project ? "AND m.project = ?" : ""}
      ORDER BY distance
    `
      )
      .all(
        ...(project
          ? [Buffer.from(queryVec.buffer), Buffer.from(queryVec.buffer), CANDIDATE_POOL_SIZE, project]
          : [Buffer.from(queryVec.buffer), Buffer.from(queryVec.buffer), CANDIDATE_POOL_SIZE])
      ) as Memory[];
    return rows;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "vec SQL query failed"
    );
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
