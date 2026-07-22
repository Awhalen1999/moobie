# Architecture

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
Data comes from each tracked user's public diary RSS feed
(`letterboxd.com/{username}/rss/`) — no official API, no Discord gateway; the
bot is HTTP/cron only.

## Status

1. ✅ **Core backend** — schema, shared `@moobie/core`, RSS ingest, hourly poll.
2. ✅ **Discord bot** — hourly announcement cards plus the commands: `/track`,
   `/untrack`, `/film`, `/film-key`, `/review`, `/review-key`, `/best`,
   `/worst`, `/favorite`, `/stats`, `/refresh`. (`/vs` was cut; its
   implementation lives in git history.)
3. 🔨 **Web** — the node graph (the site's centerpiece) is built; films /
   people / stats pages and a navigation concept are next. **Not deployed
   until it's called ready** — the bot ships independently.

## Components

Two deploys, one D1 database.

| Component     | Role                                                      | Hosting             |
|---------------|-----------------------------------------------------------|---------------------|
| `moobie-app`  | Web frontend + all HTTP (API routes, Discord `/interactions`) | Astro on Cloudflare |
| `moobie-poll` | Hourly cron: ingest feeds, announce new logs, own delivery | Cloudflare Worker   |
| D1            | SQLite, bound to both as `DB`                              | Cloudflare          |

The separate Worker exists only because the Astro app can't run a cron trigger.
Both deploys import `@moobie/core` (raw TypeScript, transpiled by each deploy's
bundler — no build step):

- `db` — the single query module; every function takes the D1 binding as its
  first argument.
- `letterboxd` — RSS fetch + parse behind one boundary.
- `analytics` — pure comparison functions, shared by every surface.
- `discord` — pure embed builders. Delivery (the channel POST as the bot)
  lives in the poll Worker, its only caller.

## Data model — 2 tables

No `films` table; film fields are denormalized into `log_entries`.

**`tracked_users`** — `username` (TEXT PK, lowercased Letterboxd username, the
identity everywhere), `discord_id`, `display_name` (display-only, never a
lookup key), `avatar_url` (fetched lazily), `active` (1/0 soft-disable),
`added_at`.

**`log_entries`** — `guid` (**UNIQUE — the dedup key**), `username`,
`film_key` (the film's global Letterboxd slug), `film_title`, `film_year`,
`poster_url`, `rating` (0.5–5.0 half-steps, nullable), `watched_date`,
`rewatch`, `liked`, `review`, `link`, `source` (`'rss'`), `created_at`.

The `guid` UNIQUE constraint is load-bearing: every writer uses
`INSERT OR IGNORE`, so re-ingesting is a no-op and the poll loop is idempotent.

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
9. **D1 via the `DB` binding**, `prerender = false` on D1-touching endpoints, config in `wrangler.jsonc`, local dev on wrangler's local D1.
10. **CSV import is post-MVP** — not in v1.
11. **Secrets never land in the repo.**

## Known gaps (accepted)

- **60-min polling window** — 50+ logs inside one hour can fall off the RSS window.
- **History starts at tracking** — full back-history waits on the post-MVP CSV importer.
- **Private / draft entries never appear** in public RSS.
- **`film_key` is the global slug** — can in principle collide; fine at this scale.
- **Editing a log to add a review re-ingests it once** — Letterboxd renames the
  guid, so it looks new: one repeat announcement, one duplicate row.
  Comparisons collapse to each user's latest watch, so they're unaffected;
  count-style stats run one high.

## Notes

- `film_key` comes from the entry link (`/film/<slug>/`), falling back to a
  normalized title-year — the slug groups a film across users far more
  reliably than title+year.
- RSS mixes diary watches with list items; only watches carry
  `<letterboxd:watchedDate>`, which is the filter.
- XML is parsed with `fast-xml-parser` (no DOMParser in Workers), with
  `htmlEntities` on so references like `&#039;` decode.
- The disagreement threshold is 3 stars (`DISAGREEMENT_THRESHOLD`); it drives
  the orange card stripe, the "Biggest gap" field, and the web graph's rings.
