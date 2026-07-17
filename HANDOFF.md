# moobie — Build Spec (v1)

> Handoff doc. Everything is called **moobie**.
> Repo: `moobie`. Bot + site: moobie, live at `moobie.awln.dev`.

---

## What we're building

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
When someone logs a film, moobie posts it to Discord with their rating and a
comparison against anyone else who's rated the same film (flagging disagreements).
The website shows richer analytics — a node graph of who-watches-with-whom,
rating agreement, common films, etc.

Data comes from each tracked user's **public Letterboxd diary RSS feed**
(`letterboxd.com/{username}/rss/`). There is no official-API integration in v1
and no live Discord gateway connection — the bot is HTTP/cron only.

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
same shared `lib/` modules (DB queries, RSS fetch, analytics) so there is no
duplicated logic.

---

## Tech stack

- **Astro + Tailwind** — frontend
- **TanStack Router + Query** — client routing / data fetching
- **Astro server endpoints** (`/api/*`, `/interactions`) with `export const prerender = false`
- **Cloudflare D1** — binding name `DB`
- **`@astrojs/cloudflare` adapter** — targets Workers
- **Config lives in `wrangler.jsonc`**
- **D1 access:** `import { env } from "cloudflare:workers"` inside server endpoints; `prerender = false` on D1-touching endpoints
- **Poll Worker cron:** `0 * * * *` (every 60 min)
- **Discord out:** channel webhook (v1) → real bot token (v2)
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
| username        | TEXT PK | Letterboxd username (lowercased)         |
| discord_id      | TEXT    | for @mentions; nullable                  |
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
| review        | TEXT    | nullable                                          |
| link          | TEXT    | canonical Letterboxd entry URL                    |
| source        | TEXT    | 'rss' for v1 (future: 'csv', 'api')               |
| created_at    | TEXT    | ISO timestamp (when we ingested it)               |

**The `guid` UNIQUE constraint is load-bearing.** Every writer uses
`INSERT OR IGNORE`, so re-ingesting the same entry is a no-op and the poll loop
is idempotent.

---

## Build order

- **Phase 0 — Scaffold.** Astro app, poll Worker, `d1 create moobie`, bind to both.
- **Phase 1 — Data layer.** `schema.sql`, shared query module; all writes `INSERT OR IGNORE`.
- **Phase 2 — Fetch layer.** `getRecentEntries(username)`, RSS only, behind one function.
- **Phase 3 — Poll loop.** `scheduled()` → active users → fetch → insert → post new rows.
- **Phase 4 — Analytics.** `compareFilm(filmKey)` + growth room; pure functions.
- **Phase 5 — Discord out.** Build embed (poster, rating, comparison), POST to webhook.
- **✅ Phase 6 — CHECKPOINT: v1 core is live.** Poll → detect → post with comparison.
- **Phase 7 — Discord in.** `/interactions` route, Ed25519 on raw body, slash commands.
- **Phase 8 — Frontend.** Astro + Tailwind + TanStack, `/api/*`, node graph + stats.
- **Phase 9 — Ship.** Point `moobie.awln.dev` at the app; register commands; e2e verify.
- **Phase 10 — Post-MVP.** Bulk CSV history import; richer analytics.

---

## Invariants (do not violate)

1. **2 tables, multiple writers** — every write is `INSERT OR IGNORE` on `guid`.
2. **Film data is denormalized** into `log_entries` — no films table.
3. **Fetch is RSS behind one function** — clean boundary, no API impl in v1.
4. **Analytics are plain pure functions** — shared across Discord + web; never coupled to a route.
5. **Poll is idempotent + stateless** — re-fetching the same entries is safe; no retry logic.
6. **Ed25519 verification runs on the raw body** — before any JSON parsing.
7. **One shared DB query module** — imported by both deploys; no duplication.
8. **D1 via the `DB` binding**, `prerender = false` on D1-touching endpoints, config in `wrangler.jsonc`, local dev via `wrangler dev`.
9. **CSV import is post-MVP** — not in v1.
10. **Secrets never land in the repo.**

---

## Known gaps (acceptable for MVP)

- **60-min polling window.** 50+ films logged within one hour can fall off the RSS window. Rare; accepted.
- **History only from launch forward.** Full back-history depends on the post-MVP CSV importer.
- **Private / draft / close-friends entries never appear** in public RSS.
- **No clean film IDs from RSS** — `film_key` is the film's global slug, which can in principle collide. Acceptable at this scale.

---

## Secrets checklist

| secret                 | used by        | when       |
|------------------------|----------------|------------|
| `DISCORD_WEBHOOK_URL`  | poll Worker    | v1         |
| `DISCORD_PUBLIC_KEY`   | app            | v2 (verify)|
| `DISCORD_BOT_TOKEN`    | app + Worker   | v2         |
| `DISCORD_APP_ID`       | app + scripts  | v2         |
| `DISCORD_GUILD_ID`     | app + scripts  | v2         |

---

## Implementation notes (as built)

- The shared `lib/` is a workspace package, `@moobie/core`, imported by both
  deploys — the spec's "cleanest long-term option" for invariant #7.
- `film_key` is the film's **global Letterboxd slug** (from the entry link,
  e.g. `toy-story-4`), which every user shares for the same film — more reliable
  than title+year.
- RSS feeds mix diary watches with list items; only watches carry
  `<letterboxd:watchedDate>`, which is the filter.
- The XML is parsed with `fast-xml-parser` (no DOMParser in Workers), with
  `htmlEntities` on so numeric references like `&#039;` decode.
- A user's first poll is a **silent seed** to avoid flooding the channel.
