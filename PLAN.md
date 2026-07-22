# moobie — Plan

> The living plan + reference doc. Everything is called **moobie**.
> Repo: `moobie`. Bot + site: moobie, live at `moobie.awln.dev`.

---

## What we're building

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
When someone logs a film, moobie posts it to Discord with their rating and a
comparison against anyone else who's rated the same film (flagging
disagreements). The website shows simple stats on top of the same data.

Data comes from each tracked user's **public Letterboxd diary RSS feed**
(`letterboxd.com/{username}/rss/`). There is no official-API integration in v1
and no live Discord gateway connection — the bot is HTTP/cron only.

## Where we are

1. **✅ Core backend** — schema, shared `@moobie/core` package, RSS ingest,
   hourly poll. Deployed and ingesting.
2. **✅ Discord bot** — hourly announcement cards, plus the full slash-command
   set via the Ed25519-verified `/interactions` route: `/track`, `/untrack`,
   `/film`, `/film-key`, `/review`, `/review-key`, `/best`, `/worst`,
   `/favorite`, `/stats`, `/refresh`. (`/vs` was cut — a better head-to-head is
   post-MVP; the old implementation lives in git history.)
3. **⬜ Frontend** — the work in front of us. See "Stage 3 plan" below.

---

## Architecture

Two deploys, one D1 database.

| Component     | Role                                                        | Hosting            |
|---------------|------------------------------------------------------------|--------------------|
| **moobie app**  | Frontend + all HTTP (API routes, Discord `/interactions`) | Astro on Cloudflare |
| **moobie-poll** | Hourly cron poll: ingest feeds, announce new logs         | Cloudflare Worker   |
| **D1**          | SQLite, bound to both                                     | Cloudflare          |

The separate Worker exists **only** because the Astro app can't run a cron
trigger. Both deploys import the same shared `@moobie/core` package so there is
no duplicated logic:

- `db` — the single DB query module; every function takes the D1 binding as its
  first argument.
- `letterboxd` — RSS fetch + parse behind one boundary.
- `analytics` — pure comparison functions.
- `discord` — pure embed builders (every card moobie posts). Delivery — the
  actual channel POST as the bot — lives in the poll Worker, its only caller.

Core ships raw TypeScript; each deploy's bundler transpiles it — no build step,
no drift.

## Tech stack

- **Astro + Tailwind** — frontend
- **Astro server endpoints** (`/api/*`, `/interactions`) with `export const prerender = false`
- **Cloudflare D1** — binding name `DB`
- **`@astrojs/cloudflare` adapter** — targets Workers
- **Config lives in `wrangler.jsonc`**
- **D1 access:** `import { env } from "cloudflare:workers"` inside server endpoints
- **Poll Worker cron:** `0 * * * *` (every 60 min)
- **Discord out:** bot token, plain REST `POST /channels/{id}/messages` — no webhooks
- **Discord in:** Astro `/interactions` route, Ed25519-verified
- **Secrets:** via `wrangler secret put` (never in the repo)
- **Local dev:** must run under `wrangler dev`
- **Deploy:** `pnpm deploy` in each of `moobie-app/` and `moobie-poll/`

---

## Data model — 2 tables only

No `films` table. Film fields are **denormalized** into `log_entries`.

### `tracked_users`

| column          | type    | notes                                    |
|-----------------|---------|------------------------------------------|
| username        | TEXT PK | Letterboxd username (lowercased) — the identity everywhere |
| discord_id      | TEXT    | for @mentions; nullable                  |
| display_name    | TEXT    | friendly name for cards; display-only, never a lookup key; nullable |
| avatar_url      | TEXT    | Letterboxd pfp for embeds; fetched lazily; nullable |
| active          | INTEGER | 1/0, soft-disable without deleting rows  |
| added_at        | TEXT    | ISO timestamp                            |

### `log_entries`

| column        | type    | notes                                             |
|---------------|---------|---------------------------------------------------|
| guid          | TEXT    | **UNIQUE** — the dedup key (RSS `<guid>`)         |
| username      | TEXT    | FK → tracked_users.username                        |
| film_key      | TEXT    | normalized slug, groups entries across users       |
| film_title    | TEXT    |                                                   |
| film_year     | INTEGER | nullable                                          |
| poster_url    | TEXT    | nullable                                          |
| rating        | REAL    | 0.5–5.0 in half-steps; nullable                   |
| watched_date  | TEXT    | ISO date                                          |
| rewatch       | INTEGER | 1/0                                               |
| liked         | INTEGER | 1/0, the Letterboxd heart (`letterboxd:memberLike`) |
| review        | TEXT    | nullable                                          |
| link          | TEXT    | canonical Letterboxd entry URL                    |
| source        | TEXT    | 'rss' for v1 (future: 'csv', 'api')               |
| created_at    | TEXT    | ISO timestamp (when we ingested it)               |

**The `guid` UNIQUE constraint is load-bearing.** Every writer uses
`INSERT OR IGNORE`, so re-ingesting the same entry is a no-op and the poll loop
is idempotent.

---

## As built (stages 1–2)

The poll: `scheduled()` → active users → fetch each feed → `INSERT OR IGNORE`
→ announce each genuinely new row (oldest watch first) to every channel in
`DISCORD_ANNOUNCE_CHANNEL_IDS` — one pool of data, N places it speaks. A user's
*first* ingest is stored silently, so `/track`-ing someone never floods the
channel. One user's failed feed never stops the rest. A `TRIGGER_KEY`-guarded
`GET /poll` runs the same poll on demand (`/refresh` uses it).

The commands: all inbound traffic hits the Astro `/interactions` route, which
verifies Discord's Ed25519 signature on the **raw body** (WebCrypto, no extra
deps) before any JSON parsing. `/track` and `/refresh` defer (network work >
Discord's 3s window); everything else answers directly. Display names are
card-rendering only (`display_name ?? username` at the edge); commands always
take Letterboxd usernames as input.

The cards: built by pure functions in `@moobie/core/discord` — `buildEntryEmbed`
(announcements and `/review`), `buildFilmEmbed` (`/film`), `buildStatsEmbed`
(`/stats`), `buildSuperlativeEmbed` (`/best`, `/worst`), `buildFavoritesEmbed`
(`/favorite`). Letterboxd green, orange when the disagreement threshold trips.

Command registration: `scripts/register-commands.mjs`, guild-scoped so updates
appear instantly (`DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs`).
Re-run it whenever a command definition changes — PUT replaces the whole set.

## Stage 3 plan — frontend (super simple)

- Astro + Tailwind pages over `/api/*` server endpoints (`prerender = false`).
- v1 pages: recent activity feed, film page (everyone's ratings + disagreement),
  per-user page. That's it — fancy visualizations are post-MVP.
- Point `moobie.awln.dev` at the app; e2e verify.

## Post-MVP

- Bulk CSV history import (full back-history).
- Head-to-head v2 (replaces the cut `/vs`).
- Richer analytics: who-watches-with-whom node graph, taste-similarity scores.

---

## Language

One vocabulary, used everywhere the bot speaks. (Code and docs may use
Letterboxd's own terms — e.g. "diary" — only when describing *their* API
surface; schema names keep their semantics: `watched_date`, `log_entries`.)

| term | means |
|------|-------|
| **log** | one watch of one film by one person — the row. Exists with or without a rating/review. Display dates say "Logged". |
| **rating** | the stars (0.5–5.0); optional property of a log |
| **review** | the written text; optional property of a log |
| **liked** | the ❤️, from `letterboxd:memberLike` |
| **rewatch** | the 🔁, from `letterboxd:rewatch` |
| **feed** | a user's Letterboxd RSS source (never "diary" in bot text) |
| **pool** | the tracked people and their data — one pool, shared across servers |
| **server** | a Discord place moobie speaks in; joining/leaving never touches the pool |
| **favorite** | a film someone liked — shown at its most recent liked log |
| **track / untrack** | add a feed to the pool / soft-disable it |
| **card** | any embed moobie posts |
| **Biggest gap** | the disagreement field: the two extreme raters, shown when spread ≥ 1.5 |

Bot-facing text uses plain hyphens, never em-dashes.

**Voice.** Plain short sentences, nothing trying to be funny. Misses end in
"yet" and carry no emoji; successes get exactly one leading emoji (🎬 👋 ✅).
Never name the machinery (Workers, polling, RSS internals) in a reply. Passive
is fine; system-speak ("automatically", "currently") is not.

## Invariants (do not violate)

Code comments cite these by number — the numbering is stable.

1. **2 tables, multiple writers** — every write is `INSERT OR IGNORE` on `guid`.
2. **Film data is denormalized** into `log_entries` — no films table.
3. **Fetch is RSS behind one function** — clean boundary, no API impl in v1.
4. **Analytics are plain pure functions** — shared across Discord + web; never coupled to a route.
5. **Poll is idempotent + stateless** — re-fetching the same entries is safe; no retry logic.
6. **Discord delivery uses the bot token** — never channel webhooks.
7. **Ed25519 verification runs on the raw body** — before any JSON parsing.
8. **One shared DB query module** — imported by both deploys; no duplication.
9. **D1 via the `DB` binding**, `prerender = false` on D1-touching endpoints, config in `wrangler.jsonc`, local dev via `wrangler dev`.
10. **CSV import is post-MVP** — not in v1.
11. **Secrets never land in the repo.**

---

## Known gaps (acceptable for MVP)

- **60-min polling window.** 50+ films logged within one hour can fall off the RSS window. Rare; accepted.
- **History only from launch forward.** Full back-history depends on the post-MVP CSV importer.
- **Private / draft / close-friends entries never appear** in public RSS.
- **No clean film IDs from RSS** — `film_key` is the film's global slug, which can in principle collide. Acceptable at this scale.
- **Editing a log to add a review re-ingests it once.** Letterboxd renames the
  entry's guid (`letterboxd-watch-…` → `letterboxd-review-…`), so it looks new:
  one repeat announcement + one duplicate row. Comparisons are unaffected (they
  collapse to each user's latest watch); count-style stats run one high.
  Accepted — new watches always create new rows by design; only this edit case
  double-counts, and heuristic dedup isn't worth the risk.

---

## Moving servers (runbook)

One data pool; servers are just places moobie speaks. To move (or add) a server:

1. **Invite the bot** — OAuth URL (App ID + `bot applications.commands` scopes +
   View Channels / Send Messages / Embed Links). Private bot: only the owner can
   authorize, and needs Manage Server in the target.
2. **Announce target** — edit `DISCORD_ANNOUNCE_CHANNEL_IDS` in
   `moobie-poll/wrangler.jsonc` (comma-separated; add for both, replace to move),
   then `wrangler deploy` from `moobie-poll/`.
3. **Slash commands** — `DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=<new server> node
   scripts/register-commands.mjs` (guild-scoped, instant).
4. Optionally kick the bot from the old server. Nothing else changes: DB, token,
   public key, app ID, and the Astro app deploy are all server-agnostic.

## Secrets & config

Secrets (set with `wrangler secret put`, never committed):

| secret              | where       | why                                        |
|---------------------|-------------|--------------------------------------------|
| `DISCORD_BOT_TOKEN` | poll Worker | posts announcements as the bot             |
| `TRIGGER_KEY`       | poll Worker + app | guards `GET /poll`; `/refresh` calls it with the same key |

Plain vars (in `wrangler.jsonc`, not secret):

- `DISCORD_PUBLIC_KEY` (app) — verifies the Ed25519 signature on `/interactions`.
- `MOOBIE_POLL_URL` (app) — the poll Worker, for `/refresh`.
- `DISCORD_ANNOUNCE_CHANNEL_IDS` (poll Worker) — comma-separated channel ids;
  one data pool broadcast to N channels, can span servers.

Script-side (`scripts/register-commands.mjs`): the app ID is hardcoded (a public
identifier, never changes); `DISCORD_GUILD_ID` defaults to moobie's home server
with an env override — see the runbook above.

---

## Implementation notes

- `@moobie/core` is a pnpm workspace package shipping raw TypeScript; each
  deploy's bundler transpiles it — no build step, no drift.
- `film_key` is the film's **global Letterboxd slug** (from the entry link,
  e.g. `toy-story-4`), which every user shares for the same film — more reliable
  than title+year.
- RSS feeds mix diary watches with list items; only watches carry
  `<letterboxd:watchedDate>`, which is the filter.
- The XML is parsed with `fast-xml-parser` (no DOMParser in Workers), with
  `htmlEntities` on so numeric references like `&#039;` decode.
