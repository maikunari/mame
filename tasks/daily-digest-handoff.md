# Handoff: dAIly digest — Build Spec for Sonnet Implementation Session

**Prior session:** Opus 4.7 (1M context). Architecture locked, data contract agreed, ready to build.
**This session:** Sonnet 4.6. Your job: implement Phases 1, 2, 4, 5 in sequence. Phase 3 (magazine template HTML/CSS) is deferred to a separate Opus + `/impeccable` session — do NOT build it here.

## Product summary

Daily personal intelligence magazine generated from Mike's X bookmarks. Hosted at `https://dailydigest.sonicpixel.io` via Cloudflare Tunnel to TH50. Editorial-quality design (see reference: screenshot of "alumni circle — this week in A.I." with serif display, cream background, yellow keyword highlights, numbered sections, drop caps). Daily Discord ping with a teaser + link when a new issue drops.

The goal is to turn Mike's bookmark slush pile — which never gets re-read — into a daily publication he'll actually open.

## Status as of handoff (2026-04-19)

**Prep already done:**
- X Developer "Pay Per Use" app created (owned reads $0.001/req from 2026-04-20)
- OAuth 2.0 enabled in X dev portal, Confidential client, Read scope only
- Callback URI registered: `http://localhost:3847/x/callback`
- `X_CLIENT_ID` and `X_CLIENT_SECRET` stored in Mame's vault (global scope)
- Mike's bookmark folders in X match desired sections (Claude Code, AI skills, Design, AI-assisted SEO, Money ideas, Trading, etc.)

**Decisions locked — do NOT re-litigate:**
- Publication name: **dAIly digest** (style the "AI" as a visual accent)
- URL: `https://dailydigest.sonicpixel.io` (Cloudflare Tunnel → TH50 port 3847)
- Cadence: **daily**, fires on heartbeat at a morning-JST time TBD (propose 6am JST)
- Volume: ~10 bookmarks/day + **5 Old Gold** (older bookmarks resurfaced with thematic ties)
- Sections: **map directly to X bookmark folders** (API exposes folder structure — confirmed via OpenClaw's prior integration)
- Sonnet builds Phases 1/2/4/5. Opus + `/impeccable` builds Phase 3 in a separate session.
- JSON schema for a magazine issue: see "Data Contract" section below — locked, don't change.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Heartbeat (daily 6am JST)                               │
│   ↓                                                     │
│ Ingestor: X bookmarks API → raw JSONL                   │
│   ↓                                                     │
│ Link resolver: web_fetch each bookmark's linked URL     │
│   ↓                                                     │
│ Digest generator: LLM call(s) → structured issue JSON   │
│   ↓                                                     │
│ Renderer: issue JSON + template.html → static HTML      │
│   ↓                                                     │
│ Express static route → Cloudflare Tunnel → HTTPS        │
│   ↓                                                     │
│ Discord notification with teaser + URL                  │
└─────────────────────────────────────────────────────────┘
```

Files:
- `~/.mame/magazine/raw/bookmarks-YYYY-MM-DD.jsonl` — raw ingested bookmarks per day
- `~/.mame/magazine/issues/YYYY-MM-DD.json` — structured issue (input for renderer)
- `~/.mame/magazine/public/YYYY-MM-DD.html` — rendered HTML (served by Express)
- `~/.mame/magazine/public/latest.html` — symlink or copy of most recent issue
- `~/.mame/magazine/state.json` — tracking state: `lastSyncedBookmarkId`, `oldGoldResurfaceLog` (map of `bookmarkId → lastResurfacedAt`)

## Data Contract — LOCKED

```json
{
  "issueNumber": 1,
  "date": "2026-04-19",
  "volume": 1,
  "masthead": {
    "title": "dAIly digest",
    "dateRange": "April 19, 2026",
    "fromLocation": "Kamakura, Japan",
    "runtime": "00:14:22"
  },
  "signal": "One-line editorial headline summarizing the day's drift",
  "sections": [
    {
      "number": "01",
      "slug": "claude-code",
      "title": "Claude Code",
      "subtitle": "New features & shipped skills",
      "items": [
        {
          "id": "bm_1234",
          "source": "x",
          "sourceUrl": "https://x.com/user/status/...",
          "linkedUrl": "https://anthropic.com/...",
          "linkedTitle": "Claude Code 0.8.0 release notes",
          "savedAt": "2026-04-19T14:30:00Z",
          "summary": "Two sentences about what this actually is.",
          "whyItMatters": "One sentence tied to Mike's current work — why should he care?",
          "isOldGold": false
        }
      ]
    }
  ],
  "oldGold": [
    {
      "id": "bm_old_42",
      "source": "x",
      "sourceUrl": "...",
      "linkedUrl": "...",
      "linkedTitle": "...",
      "savedAt": "2025-08-12T...",
      "summary": "...",
      "resurfaceReason": "Thematic match — today's items about MCP auth flow remind me of this OAuth PKCE piece you saved last summer.",
      "daysSinceSaved": 250
    }
  ],
  "stats": {
    "savedToday": 10,
    "totalProcessed": 423,
    "topCategory": "Claude Code"
  }
}
```

## Phase 1: OAuth 2.0 PKCE + Bookmarks API

**Goal:** `mame x auth` completes the OAuth handshake and stores rotating access/refresh tokens. A `bookmarks_fetch` tool retrieves new bookmarks via folder.

**Files to create:**

1. **`src/x-auth.ts`** (~120 LOC)
   - `generatePkceChallenge()` → `{verifier, challenge}` using `crypto.randomBytes` + SHA256
   - `buildAuthorizeUrl(clientId, challenge, state)` → the URL user opens in browser
   - `exchangeCodeForTokens(code, verifier, clientId, clientSecret)` → POST to `https://api.x.com/2/oauth2/token`
   - `refreshAccessToken(refreshToken, clientId, clientSecret)` → POST to same endpoint with `grant_type=refresh_token`
   - Required scopes: `tweet.read users.read bookmark.read offline.access` (the `offline.access` is what gives us refresh tokens)
   - Uses X's PKCE flow; X specifically allows `http://localhost` per RFC 8252

2. **`src/cli.ts`** — add subcommands:
   - `mame x auth` — generates PKCE, prints authorize URL, waits for callback, stores tokens in vault as `X_ACCESS_TOKEN`, `X_REFRESH_TOKEN`, `X_TOKEN_EXPIRES_AT`
   - `mame x status` — prints whether tokens are stored, expiry, last refresh
   - `mame x revoke` — deletes stored tokens
   - `mame x test-fetch` — one-shot fetch that prints raw bookmarks JSON (for debugging)

3. **`src/gateway.ts`** — add Express route:
   ```ts
   this.webhookServer.get("/x/callback", async (req, res) => {
     const { code, state } = req.query;
     // validate state against in-memory map set during `mame x auth`
     // exchange code for tokens via x-auth.ts
     // store in vault
     // send HTML success page so user sees confirmation in browser
   });
   ```

4. **`src/tools/x.ts`** (~150 LOC) — the `bookmarks_fetch` tool:
   ```ts
   {
     name: "bookmarks_fetch",
     input_schema: {
       action: "list" | "by_folder" | "by_id",
       folder?: string,        // X folder name
       sinceId?: string,       // only bookmarks newer than this
       limit?: number,         // default 20, max 100
     }
   }
   ```
   - Handles token refresh automatically (check expiry → refresh if <60s → retry on 401)
   - Uses X API v2 endpoints:
     - `GET /2/users/:id/bookmarks` (flat list)
     - `GET /2/users/:id/bookmarks/folders` (confirm folder support)
     - `GET /2/users/:id/bookmarks/folders/:folder_id/bookmarks` (scoped by folder — verify this exists)
   - Returns structured JSON with bookmark ID, source tweet URL, linked URL, text, saved timestamp

5. **`src/tools/index.ts`** — register the new tool

**Verification:** After building, Mike runs `mame x auth` on TH50, completes browser consent, then `mame x test-fetch` should print his bookmarks.

## Phase 2: Digest Generator

**Goal:** A function `generateDailyDigest()` that: fetches new bookmarks, resolves links, categorizes via LLM, picks Old Gold, and writes the JSON contract above to disk.

**Files:**

6. **`src/magazine/ingest.ts`** (~100 LOC)
   - Call `bookmarks_fetch` with `sinceId` from state.json
   - For each new bookmark with a linked URL: call `web_fetch` to resolve the actual article content (timeout 15s, fallback to bookmark text if fetch fails)
   - Write raw data to `~/.mame/magazine/raw/bookmarks-YYYY-MM-DD.jsonl` (one item per line)
   - Update state.json with the newest `bookmarkId` seen

7. **`src/magazine/digest.ts`** (~200 LOC) — the heart of the magazine
   - Load raw JSONL for today
   - **Group by folder** (folder → section)
   - For each item: single LLM call returning `{summary, whyItMatters}` — use `persona.models.complex` for quality (GLM 5.1 or MiniMax M2.7 via pi-ai; taste matters here). Parallelize with `Promise.allSettled` up to N=5 concurrent.
   - Generate Old Gold:
     - Query all past bookmarks (maintain a `~/.mame/magazine/archive/bookmarks.db` or JSONL) where `resurfaceLog[id]` is null or >90 days ago
     - Pick 5 with strong thematic overlap to today's themes — one more LLM call: "here are today's themes X, Y, Z; here are 20 candidate old bookmarks; pick 5 with the strongest thematic ties and write a one-sentence resurfaceReason for each"
   - Generate the `signal` headline — final LLM call: "one-line editorial headline for this issue"
   - Assemble the full JSON per the data contract
   - Write to `~/.mame/magazine/issues/YYYY-MM-DD.json`

8. **`src/magazine/state.ts`** (~50 LOC) — state.json read/write helpers

**Verification:** Run `node -e "require('./src/magazine/digest.js').generateDailyDigest()"` and inspect the generated JSON against the contract.

## Phase 3: Magazine HTML/CSS Template — DEFERRED

**Do NOT build this in the Sonnet session.** Mike will run a separate Opus + `/impeccable` session for this.

The deliverable from that session will be:
- `src/magazine/template/index.html` (with Mustache or Handlebars placeholders)
- `src/magazine/template/styles.css`
- Both designed against the reference screenshot Mike shared (serif editorial, cream bg, yellow highlights, numbered sections, drop caps — evokes printed magazine like The New Yorker or The Believer)

When that exists, Phase 4 can proceed.

## Phase 4: Renderer + Express Route

**Goal:** Static HTML generated from template + issue JSON, served by Mame's existing Express server.

**Files:**

9. **`src/magazine/render.ts`** (~80 LOC)
   - Reads `src/magazine/template/index.html` + `styles.css`
   - Reads a specific `issues/YYYY-MM-DD.json`
   - Fills placeholders (use a minimal template engine like `handlebars` or even plain `.replace()` — Mike hates deps)
   - Inlines CSS (for simpler hosting, smaller HTTP round-trips)
   - Writes `~/.mame/magazine/public/YYYY-MM-DD.html`
   - Updates `~/.mame/magazine/public/latest.html` to match

10. **`src/gateway.ts`** — add static route:
    ```ts
    this.webhookServer.use("/magazine", express.static(path.join(MAME_HOME, "magazine/public")));
    ```
    And a small index handler at `/magazine/` listing recent issues reverse-chronologically.

**Verification:** `curl http://localhost:3847/magazine/latest.html` returns the rendered HTML.

## Phase 5: Heartbeat Wiring + Discord Notification

**Goal:** Daily trigger, end-to-end: ingest → generate → render → notify.

**Files:**

11. **`~/.mame/HEARTBEAT.md`** — append new entry:
    ```
    ## Every morning at 6:00 — DAILY DIGEST
    - Call generateDailyDigest() (ingest X bookmarks + resolve links + categorize)
    - Render issue HTML via render.ts
    - Post Discord notification with signal headline + URL to dailydigest.sonicpixel.io/YYYY-MM-DD
    - On failure, post error summary to #mame (not #mame-minimax)
    ```

12. **`src/heartbeat.ts`** — recognize this structured heartbeat entry OR add a dedicated scheduled job that calls the digest directly (depends on existing heartbeat design — check what fits)

13. **Discord teaser format** (post to `#mame` channel):
    ```
    📰 **dAIly digest #42 is out** — *"One-line editorial headline"*
    → https://dailydigest.sonicpixel.io/2026-04-19
    ```

**Verification:** Wait for next heartbeat fire (or manually trigger it), confirm Discord notification and that URL loads.

## Phase 6: Cloudflare Tunnel (separate — no code)

Mike sets up Cloudflare Tunnel mapping `dailydigest.sonicpixel.io` → `localhost:3847` on TH50. This is DNS + CF dashboard work, not Mame code. You can write a short Markdown guide in `tasks/cloudflare-tunnel-setup.md` as a deliverable if time permits, but don't block on this.

## Non-negotiable constraints

- **Do not add new npm dependencies without strong justification.** Mike has pushed back on this consistently. Node stdlib covers PKCE (crypto). Use existing `yaml`, `better-sqlite3`, `express`. If you think you need a new dep, flag it and ask.
- **All secrets go through the vault.** Never write tokens to plain files. Use `vault.set("global", "X_ACCESS_TOKEN", ...)` and `vault.get(...)`.
- **No `any` types unless truly necessary.** Mame is strict TypeScript.
- **pino logs, not console.log** in new code. Use `childLogger("magazine")` per module.
- **YAML validation is built into self_config** — don't let the LLM-generated digest clobber any config file.
- **Preserve Mame's existing patterns** — tool registration via `registerTool()`, ToolContext for per-turn data, Zod schemas for config.

## Suggested implementation order

1. Phase 1 first, end-to-end (Mike needs to run `mame x auth` to unblock anything else)
2. Mike runs auth, confirms tokens stored, ping to proceed
3. Phase 2 — digest generator (can be tested without template by just inspecting JSON output)
4. Pause. Phase 3 happens in a separate Opus session.
5. Once template exists, Phase 4 + Phase 5 wire it all up

## Hand-off protocol

When you start the new Sonnet session, paste this entire doc as the first message along with:

> "Read `tasks/daily-digest-handoff.md` — this is my brief for the dAIly digest feature. We're picking up at Phase 1. Do NOT re-scope, re-design, or re-negotiate the data contract. The decisions in the 'Status' section are locked. Start with Phase 1 and proceed through Phases 2, 4, 5 as described. Stop before Phase 3 — that's a separate Opus session. Read the existing codebase to understand the tool registration pattern, gateway structure, and vault usage before writing code. Ask before adding any npm dependency."

## Outstanding TODOs from this session

1. ✅ Architecture locked
2. ✅ Data contract locked
3. ✅ Sonnet vs Opus split decided
4. ✅ Handoff doc written (this file)
5. ⏳ Mike starts Sonnet session → builds Phases 1, 2, 4, 5
6. ⏳ Mike runs `mame x auth` on TH50 between Phases 1 and 2
7. ⏳ Mike opens Opus + `/impeccable` session → builds Phase 3 template
8. ⏳ Mike sets up Cloudflare Tunnel for `dailydigest.sonicpixel.io`
9. ⏳ First live issue drops → iterate on design based on how it actually reads
