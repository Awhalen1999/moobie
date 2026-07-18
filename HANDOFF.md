# moobie — Build Spec (v1)

> Handoff doc. Everything is called **moobie**.
> Repo: `moobie`. Bot + site: moobie, live at `moobie.awln.dev`.

---

## What we're building

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
When someone logs a film, moobie posts it to Discord with their rating and a
comparison against anyone else who's rated the same film (flagging disagreements).
The website shows simple stats on top of the same data.

Data comes from each tracked user's **public Letterboxd diary RSS feed**
(`letterboxd.com/{username}/rss/`). There is no official-API integration in v1
and no live Discord gateway connection — the bot is HTTP/cron only.

## The plan — three stages, in order

1. **✅ Core backend** — schema, shared query module, RSS fetch, hourly poll
   loop (ingest-only), analytics. Done and deployed. This is the foundation
   everything else reads from; it stays simple and linear.
2. **Discord bot** — a real bot (bot token) from day one. Announces new logs
   with the rating comparison, plus slash commands via `/interactions`.
   **No channel webhooks — that was never the plan.**
3. **Frontend** — super simple. A few Astro pages over `/api/*`: recent
   activity, per-film comparisons, basic per-user stats. Fancy visualizations
   (node graph etc.) are post-MVP.

---

## Architecture

Two deploys, one D1 database.

| Component     | Role                                                        | Hosting            |
|---------------|------------------------------------------------------------|--------------------|
| **moobie app**  | Frontend + all HTTP (API routes, Discord `/interactions`) | Astro on Cloudflare |
| **moobie-poll** | Hourly cron poll only (~20 lines of glue)                 | Cloudflare Worker   |
| **D1**          | SQLite, bound to both                                     | Cloudflare          |

The separate Worker exists **only** because the Astro app can't run a cron
trigger. All non-cron logic lives in the Astro app. Both deploys import the
same shared `@moobie/core` package (DB queries, RSS fetch, analytics, embed
builders) so there is no duplicated logic.

---

## Tech stack

- **Astro + Tailwind** — frontend
- **Astro server endpoints** (`/api/*`, `/interactions`) with `export const prerender = false`
- **Cloudflare D1** — binding name `DB`
- **`@astrojs/cloudflare` adapter** — targets Workers
- **Config lives in `wrangler.jsonc`**
- **D1 access:** `import { env } from "cloudflare:workers"` inside server endpoints; `prerender = false` on D1-touching endpoints
- **Poll Worker cron:** `0 * * * *` (every 60 min)
- **Discord out:** bot token, plain REST `POST /channels/{id}/messages` — no webhooks
- **Discord in:** Astro `/interactions` route, Ed25519-verified
- **Secrets:** via `wrangler secret put` (never in the repo)
- **Local dev:** must run under `wrangler dev`
- **Deploy:** Astro app + `wrangler deploy` for the poll Worker

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
| last_seen_guid  | TEXT    | optional optimization; dedup is by guid regardless |
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

## Stage 1 — Core backend ✅ (as built)

Poll → parse → store. Nothing else. Deployed and ingesting hourly.

- `db/schema.sql` — the 2 tables above, plus film_key / username indexes.
- `@moobie/core/db` — the single DB module (invariant #7); every function takes
  the `D1Database` binding as its first arg, all writes `INSERT OR IGNORE`.
- `@moobie/core/letterboxd` — `getRecentEntries(username)`, RSS behind one
  function (invariant #3). `fast-xml-parser`, watches filtered by
  `<letterboxd:watchedDate>`, `film_key` = the film's global Letterboxd slug.
- `@moobie/core/analytics` — `compareFilm()` + growth room; pure functions
  (invariant #4).
- `@moobie/core/discord` — **pure embed builders only** (`buildEntryEmbed`,
  `stars`). No delivery code in core; the bot owns sending.
- `moobie-poll` — `scheduled()` → active users → fetch → insert; one user's
  failed feed never stops the rest. Also a `TRIGGER_KEY`-guarded `GET /poll`
  for on-demand runs.

Because stage 1 ingests silently, the whole backlog is already in the DB before
the bot exists — no announcement flood when stage 2 ships.

## Stage 2 — Discord bot

Real bot token from the start. No webhooks at any point.

- Create the Discord app + bot; invite to the guild.
- **Announce:** poll Worker posts each genuinely new row (oldest watch first)
  via `POST /channels/{id}/messages` with the bot token, using
  `buildEntryEmbed(entry, compareFilm(...))` from core — to every channel in
  `DISCORD_ANNOUNCE_CHANNEL_IDS`.
- **Silent seed:** a user's *first* ingest is stored but never announced, so
  adding someone doesn't flood the channel.
- **Slash commands:** Astro `/interactions` route. Ed25519 verification on the
  **raw body** (WebCrypto, no extra deps), before any JSON parsing.
  - ✅ `/track <username> [display_name]` — validates the feed, grabs the avatar,
    upserts (re-track updates details), seeds the backlog silently. Deferred
    reply (network work > Discord's 3s window).
  - ✅ `/untrack <username>` — soft-disable; history stays.
  - Next: `/film <title>` (comparison card), `/stats`, `/refresh` (manual poll),
    `/vs <user1> <user2>` (head-to-head).
- ✅ Command registration script: `scripts/register-commands.mjs`, guild-scoped
  (`DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs`).
- Display names are card-rendering only (`display_name ?? username` at the edge);
  commands always take Letterboxd usernames as input.

## Stage 3 — Frontend (super simple)

- Astro + Tailwind pages over `/api/*` server endpoints (`prerender = false`).
- v1 pages: recent activity feed, film page (everyone's ratings + disagreement),
  per-user page. That's it.
- Point `moobie.awln.dev` at the app; e2e verify.

## Post-MVP

- Bulk CSV history import (full back-history).
- Richer analytics: who-watches-with-whom node graph, taste-similarity scores.

---

## Invariants (do not violate)

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

---

## Secrets checklist

| secret                 | used by        | stage |
|------------------------|----------------|-------|
| `TRIGGER_KEY`          | poll Worker    | 1     |
| `DISCORD_BOT_TOKEN`    | poll Worker + app | 2  |
| `DISCORD_PUBLIC_KEY`   | app (`/interactions` verify) | 2 |
| `DISCORD_APP_ID`       | app + scripts  | 2     |
| `DISCORD_GUILD_ID`     | app + scripts  | 2     |
Announce targets are **not** a secret: `DISCORD_ANNOUNCE_CHANNEL_IDS` (comma-separated
channel ids — one data pool broadcast to N channels, can span servers) lives in
`moobie-poll/wrangler.jsonc` vars. Moving/adding a server is a config edit.

---

## Implementation notes (as built)

- The shared `lib/` is a workspace package, `@moobie/core`, imported by both
  deploys — the cleanest way to satisfy invariant #8. It ships raw TypeScript;
  each deploy's bundler transpiles it — no build step, no drift.
- `film_key` is the film's **global Letterboxd slug** (from the entry link,
  e.g. `toy-story-4`), which every user shares for the same film — more reliable
  than title+year.
- RSS feeds mix diary watches with list items; only watches carry
  `<letterboxd:watchedDate>`, which is the filter.
- The XML is parsed with `fast-xml-parser` (no DOMParser in Workers), with
  `htmlEntities` on so numeric references like `&#039;` decode.
