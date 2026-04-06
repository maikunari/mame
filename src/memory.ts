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
