# moobie

A Discord bot for a friend group that logs films on Letterboxd. When someone
logs a film, moobie announces it with their rating and how everyone else rated
it — disagreements get flagged. Slash commands cover the rest: look up a film,
someone's latest review, their best and worst, their favorites, the stats.

Everything runs off each person's public Letterboxd RSS feed, checked hourly.
No API keys, no gateway connection — a cron, a small database, and cards.

## Layout

```
moobie/
├── db/schema.sql        2 tables (tracked_users, log_entries)
├── packages/core/       @moobie/core — queries, RSS parsing, analytics, cards
├── moobie-poll/         hourly Worker: check feeds, announce new logs
└── moobie-app/          Astro app: /interactions (slash commands) + the site
```

Both deploys import `@moobie/core`, so every query, parser, and card exists
exactly once. [`PLAN.md`](./PLAN.md) has the full picture — data model,
invariants, language, runbooks.

## Running it

```sh
pnpm install

# local: apply the schema, set a dev key, run the Worker
cd moobie-poll
pnpm db:local
cp .dev.vars.example .dev.vars
pnpm dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"   # fire the cron now

# deploy — from each of moobie-poll/ and moobie-app/
pnpm deploy

# register slash commands (guild-scoped, instant)
DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
```

Local dev must run under `wrangler dev` — the plain Astro dev server can't see
D1. Secrets go in with `wrangler secret put`, never into the repo.
