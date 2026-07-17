# moobie

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
When someone logs a film, moobie posts it to Discord with their rating and a
comparison against anyone else who has rated the same film (flagging
disagreements). Data comes from each tracked user's public Letterboxd diary RSS
feed — no official API, no live Discord gateway.

See [`HANDOFF.md`](./HANDOFF.md) for the full spec.

## Layout

This is a pnpm workspace with one shared package and two Cloudflare deploys.

```
moobie/
├── db/schema.sql        2 tables (tracked_users, log_entries)
├── packages/core/       @moobie/core — all shared logic:
│                          db, letterboxd (RSS), analytics, discord
├── moobie-poll/         hourly cron Worker: poll diaries → post new logs
└── moobie-app/          Astro app on Cloudflare (API + web UI, Phase 8)
```

Both deploys import `@moobie/core`, so there is exactly one copy of every query,
the RSS parser, the analytics functions, and the Discord embed builder. The core
package ships raw TypeScript; each deploy's bundler (esbuild / Vite) transpiles
it — no build step, no drift.

## How it works

`moobie-poll` runs every hour. For each active user it fetches
`letterboxd.com/{username}/rss/`, parses the diary entries (ignoring list items),
and inserts anything new with `INSERT OR IGNORE` keyed on the RSS `<guid>`. That
one UNIQUE constraint makes the whole loop idempotent: re-fetching the same
entries is a no-op. Genuinely new rows are announced to a Discord channel
webhook, oldest watch first, each with a rating-comparison embed.

A user's very first poll is treated as a silent seed (their back-catalogue is
stored but not announced) so adding someone doesn't flood the channel.

## Local development

```sh
pnpm install

# apply the schema to the Worker's local D1
cd moobie-poll
pnpm db:local

# provide a webhook for local runs
cp .dev.vars.example .dev.vars   # then edit the URL

# run the Worker and fire the cron on demand
pnpm dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

Local dev must run under `wrangler dev` — the plain Astro dev server can't see D1
bindings.

## Deploy

```sh
# once: create the DB and apply the schema to production
wrangler d1 create moobie          # already done; id is in the wrangler.jsonc files
pnpm db:remote                     # from repo root

# secrets (never committed)
cd moobie-poll
wrangler secret put DISCORD_WEBHOOK_URL

# ship the cron Worker
pnpm deploy
```

The D1 binding (`DB`) and database id are configured in both
`moobie-poll/wrangler.jsonc` and `moobie-app/wrangler.jsonc`.

## Status

v1 core is complete: poll → detect new logs → post to Discord with comparison
(Phases 0–6). Still to come: Discord slash commands (`/interactions`), the web
dashboard and API, and the post-MVP CSV history import.
