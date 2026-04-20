// src/magazine/digest.ts — Assemble a daily issue JSON from raw ingested
// bookmarks. The heart of the magazine.
//
// Pipeline:
//   1. Load today's raw JSONL (ingest.ts wrote it).
//   2. Group items by folder → sections.
//   3. Per item, ask an LLM for { summary, whyItMatters }. Parallel up to 5.
//   4. Pick Old Gold candidates from the archive (>30d old, not recently
//      resurfaced) and ask the LLM to choose 5 with thematic ties.
//   5. Ask the LLM for a one-line "signal" headline.
//   6. Assemble the issue JSON per the locked data contract and write to
//      ~/.mame/magazine/issues/YYYY-MM-DD.json.
//
// LLM model: persona.models.complex if set, else persona.models.default.

import fs from "fs";
import {
  completeSimple,
  getModel,
  type Context,
  type KnownProvider,
  type AssistantMessage,
} from "@mariozechner/pi-ai";
import { loadConfig, loadPersona, type PersonaConfig } from "../config.js";
import { parseModelString } from "../model-router.js";
import {
  archiveStats,
  issueJsonPath,
  loadState,
  pickOldGoldCandidates,
  rawJsonlPath,
  saveState,
  todayISO,
  type ArchivedBookmark,
} from "./state.js";
import type { IngestRecord } from "./ingest.js";
import { childLogger } from "../logger.js";

const log = childLogger("magazine:digest");

const MASTHEAD_TITLE = "dAIly digest";
const FROM_LOCATION = "Kamakura, Japan";
const SUMMARIZE_CONCURRENCY = 5;
const OLD_GOLD_TARGET = 5;
const OLD_GOLD_CANDIDATE_POOL = 20;

// ---------------------------------------------------------------------------
// Locked data contract types — see tasks/daily-digest-handoff.md lines 60-111
// ---------------------------------------------------------------------------

export interface IssueItem {
  id: string;
  source: "x";
  sourceUrl: string;
  linkedUrl: string | null;
  linkedTitle: string | null;
  heroImage: string | null;
  savedAt: string | null;
  summary: string;
  whyItMatters: string;
  isOldGold: false;
}

export interface IssueSection {
  number: string;
  slug: string;
  title: string;
  subtitle: string;
  items: IssueItem[];
}

export interface IssueOldGold {
  id: string;
  source: "x";
  sourceUrl: string;
  linkedUrl: string | null;
  linkedTitle: string | null;
  heroImage: string | null;
  savedAt: string | null;
  summary: string;
  resurfaceReason: string;
  daysSinceSaved: number;
}

export interface IssueMasthead {
  title: string;
  dateRange: string;
  fromLocation: string;
  runtime: string;
}

export interface IssueStats {
  savedToday: number;
  totalProcessed: number;
  topCategory: string;
}

/** Item with its folder inlined. Used by the magazine-front layout
 *  which flattens sections into a scannable grid. */
export interface IssueItemWithFolder extends IssueItem {
  folder: string;
}

export interface MagazineIssue {
  issueNumber: number;
  date: string;
  volume: number;
  masthead: IssueMasthead;
  signal: string;
  sections: IssueSection[];
  /** Designated top story of the issue — first item of the largest section.
   *  Null when there are no items at all. Convenience derived from sections. */
  featured: IssueItemWithFolder | null;
  /** All other items, flattened in section order, folder inlined. */
  rest: IssueItemWithFolder[];
  oldGold: IssueOldGold[];
  stats: IssueStats;
}

export interface GenerateOptions {
  /** YYYY-MM-DD; defaults to today in the configured timezone. */
  date?: string;
  /** Persona name whose models[] we'll use for LLM calls. */
  personaName?: string;
}

export interface GenerateResult {
  issue: MagazineIssue;
  path: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generateDailyDigest(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const startMs = Date.now();
  const cfg = loadConfig();
  const date = opts.date ?? todayISO(cfg.timezone);
  const personaName = opts.personaName ?? "default";
  const persona = loadPersona(personaName);

  log.info({ date, persona: personaName }, "digest generation starting");

  const records = loadRawJsonl(date);
  if (records.length === 0) {
    throw new Error(`No raw bookmarks found for ${date} at ${rawJsonlPath(date)}. Run ingest first.`);
  }

  const piModel = resolveModel(persona);

  // 1. Per-item summarization (parallel)
  const summarized = await summarizeItems(records, piModel);

  // 2. Group into sections by folder
  const sections = groupIntoSections(summarized);

  // 2b. Derive a flattened scan-grid view — featured item + rest.
  //     Featured = first item of first (largest) section. Sections is
  //     already sorted largest-first in groupIntoSections.
  const flatItems: IssueItemWithFolder[] = sections.flatMap((s) =>
    s.items.map((i) => ({ ...i, folder: s.title }))
  );
  const featured: IssueItemWithFolder | null = flatItems[0] ?? null;
  const rest: IssueItemWithFolder[] = flatItems.slice(1);

  // 3. Old Gold
  const oldGold = await pickAndExplainOldGold(records, summarized, piModel);

  // 4. Signal headline
  const signal = await generateSignal(summarized, piModel);

  // 5. Stats + masthead
  const archive = archiveStats();
  const topCategory =
    sections
      .map((s) => ({ title: s.title, count: s.items.length }))
      .sort((a, b) => b.count - a.count)[0]?.title ?? "(none)";

  const state = loadState();
  const issueNumber = state.nextIssueNumber;
  state.nextIssueNumber = issueNumber + 1;
  const now = new Date();
  for (const og of oldGold) {
    state.oldGoldResurfaceLog[og.id] = now.toISOString();
  }
  saveState(state);

  const runtimeMs = Date.now() - startMs;

  const issue: MagazineIssue = {
    issueNumber,
    date,
    volume: 1,
    masthead: {
      title: MASTHEAD_TITLE,
      dateRange: formatDateRange(date),
      fromLocation: FROM_LOCATION,
      runtime: formatRuntime(runtimeMs),
    },
    signal,
    sections,
    featured,
    rest,
    oldGold,
    stats: {
      savedToday: records.length,
      totalProcessed: archive.total,
      topCategory,
    },
  };

  const outPath = issueJsonPath(date);
  fs.writeFileSync(outPath, JSON.stringify(issue, null, 2), "utf-8");
  log.info({ path: outPath, runtimeMs, items: records.length, oldGold: oldGold.length }, "digest written");

  return { issue, path: outPath };
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

interface PiModel {
  api: unknown;
  provider: unknown;
  id: unknown;
  reasoning?: boolean;
}

function resolveModel(persona: PersonaConfig): ReturnType<typeof getModel> {
  const modelString = persona.models.complex ?? persona.models.default;
  const route = parseModelString(modelString);
  // Cast through unknown — pi-ai's KnownProvider is a string-literal union we
  // don't enumerate here, and parseModelString already validates the prefix.
  const model = getModel(route.backend as unknown as KnownProvider, route.modelId as never);
  if (!model) throw new Error(`Model not found in pi-ai catalog: ${modelString}`);
  return model;
}

function extractText(response: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/**
 * Lenient JSON extractor. In order:
 *   1. Strip leading/trailing whitespace.
 *   2. If a ```json…``` (or plain ```…```) fence appears anywhere, extract
 *      its inner content first.
 *   3. Trim everything before the first `{` or `[` and after the matching
 *      closing brace/bracket.
 *   4. JSON.parse.
 * Models love to wrap JSON in prose, headers, or "**JSON Output**" preambles.
 * This recovers from all of those.
 */
function parseJsonResponse<T>(raw: string, hint: string): T {
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const firstBrace = s.search(/[{[]/);
  if (firstBrace > 0) s = s.slice(firstBrace);
  const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastBrace > 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);

  try {
    return JSON.parse(s) as T;
  } catch (err) {
    log.error({ raw, hint }, "LLM returned malformed JSON");
    throw new Error(`Malformed JSON in ${hint}: ${err}`);
  }
}

/**
 * Last-ditch parser for the {summary, whyItMatters} pair when the model
 * decides to emit markdown instead of JSON. Tolerates:
 *   **summary**: text     **whyItMatters**: text
 *   **Summary:** text     **Why It Matters:** text
 *   **SUMMARY**\ntext     **WHY IT MATTERS**\ntext
 *   ...etc. Returns null if neither field is recoverable.
 */
function parseMarkdownSummaryPair(
  raw: string
): { summary: string; whyItMatters: string } | null {
  const sumRe = /\*\*\s*summary\s*:?\s*\*\*\s*:?\s*\n?\s*([\s\S]*?)(?=\n?\s*\*\*\s*why|\n?\s*\*\*\s*whyitmatters|$)/i;
  const whyRe = /\*\*\s*(?:why\s*it\s*matters?|whyitmatters?)\s*:?\s*\*\*\s*:?\s*\n?\s*([\s\S]*?)$/i;

  const sumMatch = raw.match(sumRe);
  const whyMatch = raw.match(whyRe);
  if (!sumMatch && !whyMatch) return null;

  const summary = (sumMatch?.[1] ?? "").trim();
  const whyItMatters = (whyMatch?.[1] ?? "").trim();
  if (!summary && !whyItMatters) return null;

  return {
    summary: summary || "(summary unavailable)",
    whyItMatters: whyItMatters || "(why-it-matters unavailable)",
  };
}

async function llmJson<T>(
  piModel: ReturnType<typeof getModel>,
  systemPrompt: string,
  userPrompt: string,
  hint: string,
  maxTokens: number = 800
): Promise<T> {
  const ctx: Context = {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
  };
  const response = await completeSimple(piModel, ctx, { maxTokens });
  return parseJsonResponse<T>(extractText(response), hint);
}

async function llmText(
  piModel: ReturnType<typeof getModel>,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 200
): Promise<string> {
  const ctx: Context = {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
  };
  const response = await completeSimple(piModel, ctx, { maxTokens });
  return extractText(response);
}

// ---------------------------------------------------------------------------
// Step 1: per-item summarization
// ---------------------------------------------------------------------------

interface SummarizedItem extends IngestRecord {
  summary: string;
  whyItMatters: string;
}

const SUMMARIZE_SYSTEM = `You are an editor for Mike's daily personal intelligence magazine, "dAIly digest".
Mike is a builder: he ships AI-augmented developer tools, runs his own infra, makes daily editorial decisions about which tools and ideas are worth his attention. He saves things to X bookmarks throughout the day.

Your job: write tight, specific, useful editorial copy for each bookmark. No hype, no marketing fluff, no "in today's fast-paced AI landscape" preambles.

CRITICAL OUTPUT FORMAT — read carefully:
- Output ONLY a single JSON object. Nothing before it. Nothing after it.
- Do NOT use markdown bold (**), headers, "Summary:" labels, code fences, or any prose framing.
- Do NOT explain what you're doing. Just emit the JSON.

Schema:
{
  "summary": "Two sentences. What is this thing? Be concrete and specific.",
  "whyItMatters": "One sentence. Why should Mike care? Tie it to his work building dev tools, AI-augmented workflows, or running his own systems."
}

Example output (this is the EXACT format — nothing else):
{"summary":"Open-source CLI that wraps the Anthropic API with built-in prompt caching, streaming, and tool-use helpers. Single binary, no Node deps.","whyItMatters":"Drop-in replacement for the boilerplate Mike already writes around every Anthropic SDK call — saves hours per project."}`;

async function summarizeItems(
  records: IngestRecord[],
  piModel: ReturnType<typeof getModel>
): Promise<SummarizedItem[]> {
  const results: SummarizedItem[] = new Array(records.length);

  await mapWithConcurrency(
    records.map((r, idx) => ({ r, idx })),
    SUMMARIZE_CONCURRENCY,
    async ({ r, idx }) => {
      const userPrompt = buildItemPrompt(r);
      const ctx: Context = {
        systemPrompt: SUMMARIZE_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
      };
      let raw = "";
      try {
        const response = await completeSimple(piModel, ctx, { maxTokens: 400 });
        raw = extractText(response);

        // Try strict JSON first.
        let parsed: { summary?: string; whyItMatters?: string };
        try {
          parsed = parseJsonResponse(raw, `summarize bookmark ${r.id}`);
        } catch {
          // Markdown fallback — recover content the model put in **bold** form.
          const md = parseMarkdownSummaryPair(raw);
          if (!md) throw new Error("neither JSON nor markdown pair found");
          log.debug({ id: r.id }, "recovered summary via markdown parser");
          parsed = md;
        }

        results[idx] = {
          ...r,
          summary: parsed.summary ?? r.linkedTitle ?? r.text.slice(0, 200),
          whyItMatters: parsed.whyItMatters ?? "(why-it-matters unavailable)",
        };
      } catch (err) {
        log.warn({ id: r.id, err: String(err), raw: raw.slice(0, 300) }, "summarize failed — using fallback");
        results[idx] = {
          ...r,
          summary: r.linkedTitle ?? r.text.slice(0, 200),
          whyItMatters: "(summary unavailable)",
        };
      }
    }
  );

  return results;
}

function buildItemPrompt(r: IngestRecord): string {
  const lines: string[] = [];
  lines.push(`Bookmark folder: ${r.folder ?? "(unfiled)"}`);
  lines.push(`Saved: ${r.savedAt ?? "(unknown)"}`);
  lines.push(`Tweet text: ${r.text}`);
  if (r.linkedUrl) lines.push(`Linked URL: ${r.linkedUrl}`);
  if (r.linkedTitle) lines.push(`Link title: ${r.linkedTitle}`);
  if (r.linkedDescription) lines.push(`Link description: ${r.linkedDescription}`);
  if (r.articleExcerpt) {
    lines.push(`Article excerpt (first ~3000 chars):`);
    lines.push(r.articleExcerpt.slice(0, 3000));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 2: group into sections by folder
// ---------------------------------------------------------------------------

function groupIntoSections(items: SummarizedItem[]): IssueSection[] {
  const byFolder = new Map<string, SummarizedItem[]>();
  for (const item of items) {
    const folder = item.folder ?? "Inbox";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(item);
  }

  // Sort folders by item count desc, then alpha for stability
  const folders = [...byFolder.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  return folders.map(([folder, sectionItems], i) => ({
    number: String(i + 1).padStart(2, "0"),
    slug: slugify(folder),
    title: folder,
    subtitle: "",
    items: sectionItems.map<IssueItem>((it) => ({
      id: it.id,
      source: "x",
      sourceUrl: it.sourceUrl,
      linkedUrl: it.linkedUrl,
      linkedTitle: it.linkedTitle,
      heroImage: it.heroImage,
      savedAt: it.savedAt,
      summary: it.summary,
      whyItMatters: it.whyItMatters,
      isOldGold: false,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Step 3: Old Gold
// ---------------------------------------------------------------------------

const OLD_GOLD_SYSTEM = `You curate "Old Gold" — older bookmarks from Mike's archive that are worth resurfacing today because they thematically tie to today's drift.

Pick exactly ${OLD_GOLD_TARGET} candidates with the strongest thematic overlap. For each, write a one-sentence resurfaceReason explaining the connection — be specific about what links the old item to today's themes.

Output STRICT JSON only — no prose around it, no markdown fences. Schema:
[
  { "id": "string", "resurfaceReason": "One sentence connecting this old bookmark to today's themes." }
]`;

async function pickAndExplainOldGold(
  records: IngestRecord[],
  summarized: SummarizedItem[],
  piModel: ReturnType<typeof getModel>
): Promise<IssueOldGold[]> {
  const state = loadState();
  const todayIds = records.map((r) => r.id);
  const candidates = pickOldGoldCandidates(todayIds, state.oldGoldResurfaceLog, OLD_GOLD_CANDIDATE_POOL);

  if (candidates.length === 0) {
    log.info("no Old Gold candidates available — archive may be too small or fully recently-resurfaced");
    return [];
  }

  // Build today's themes from the summaries
  const themes = summarized
    .slice(0, 10)
    .map((s) => `- ${s.linkedTitle ?? s.text.slice(0, 80)} → ${s.summary}`)
    .join("\n");

  const candidateLines = candidates
    .map(
      (c, i) =>
        `${i + 1}. id=${c.id} | folder=${c.folder ?? "(unfiled)"} | saved=${c.saved_at} | title=${c.linked_title ?? "(none)"} | text=${c.text.slice(0, 200)}`
    )
    .join("\n");

  const userPrompt = `Today's themes (from today's bookmarks):
${themes}

Candidate older bookmarks (saved 30+ days ago, not recently resurfaced):
${candidateLines}

Pick exactly ${OLD_GOLD_TARGET} with the strongest thematic ties to today.`;

  let picks: Array<{ id: string; resurfaceReason: string }>;
  try {
    picks = await llmJson(piModel, OLD_GOLD_SYSTEM, userPrompt, "old gold pick", 1200);
  } catch (err) {
    log.warn({ err: String(err) }, "Old Gold LLM call failed — returning empty");
    return [];
  }

  const candidatesById = new Map(candidates.map((c) => [c.id, c]));
  const today = new Date();

  const out: IssueOldGold[] = [];
  for (const pick of picks.slice(0, OLD_GOLD_TARGET)) {
    const c = candidatesById.get(pick.id);
    if (!c) {
      log.warn({ id: pick.id }, "LLM picked an Old Gold id that wasn't in the candidate pool — skipping");
      continue;
    }
    const daysSince = c.saved_at
      ? Math.floor((today.getTime() - new Date(c.saved_at).getTime()) / 86400_000)
      : 0;
    out.push({
      id: c.id,
      source: "x",
      sourceUrl: c.source_url,
      linkedUrl: c.linked_url,
      linkedTitle: c.linked_title,
      heroImage: c.hero_image,
      savedAt: c.saved_at,
      summary: oldGoldSummary(c),
      resurfaceReason: pick.resurfaceReason,
      daysSinceSaved: daysSince,
    });
  }
  return out;
}

function oldGoldSummary(c: ArchivedBookmark): string {
  if (c.linked_description) return c.linked_description.slice(0, 240);
  if (c.linked_title) return c.linked_title;
  return c.text.slice(0, 240);
}

// ---------------------------------------------------------------------------
// Step 4: signal headline
// ---------------------------------------------------------------------------

const SIGNAL_SYSTEM = `You write one-line editorial headlines for "dAIly digest", a daily personal intelligence magazine.

Capture the day's drift in a single line under 80 characters. No quotes. No preamble. No "today we cover...". Editorial voice: dry, observational, specific. Think New Yorker contents page, not BuzzFeed.

Output ONLY the headline. No JSON. No markdown.`;

async function generateSignal(
  summarized: SummarizedItem[],
  piModel: ReturnType<typeof getModel>
): Promise<string> {
  const items = summarized
    .slice(0, 12)
    .map((s) => `- [${s.folder ?? "unfiled"}] ${s.linkedTitle ?? s.text.slice(0, 100)}`)
    .join("\n");

  const userPrompt = `Today's items:
${items}

Write the signal headline.`;

  try {
    const text = await llmText(piModel, SIGNAL_SYSTEM, userPrompt, 100);
    return text.replace(/^["']|["']$/g, "").trim().slice(0, 200);
  } catch (err) {
    log.warn({ err: String(err) }, "Signal LLM call failed — using fallback");
    return "Today's drift.";
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function loadRawJsonl(date: string): IngestRecord[] {
  const file = rawJsonlPath(date);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as IngestRecord);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function formatDateRange(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatRuntime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
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
