# moobie

A Discord bot + web dashboard for a friend group that logs films on Letterboxd.
When someone logs a film, moobie posts it to Discord with their rating and a
comparison against anyone else who has rated the same film (flagging
disagreements). Data comes from each tracked user's public Letterboxd diary RSS
feed — no official API, no live Discord gateway.

See [`PLAN.md`](./PLAN.md) for the full plan and reference. The build is three
stages, in order:

1. **✅ Core backend** — schema, shared core package, RSS ingest, hourly poll.
2. **✅ Discord bot** — real bot token (never webhooks). Announcements plus
   `/track`, `/untrack`, `/film`, `/film-key`, `/review`, `/review-key`,
   `/best`, `/worst`, `/favorite`, `/stats`, and `/refresh`.
3. **Frontend** — a few simple Astro pages over the same data. Up next.

## Layout

This is a pnpm workspace with one shared package and two Cloudflare deploys.

```
moobie/
├── db/schema.sql        2 tables (tracked_users, log_entries)
├── packages/core/       @moobie/core — all shared logic:
│                          db, letterboxd (RSS), analytics, discord embeds
├── moobie-poll/         hourly cron Worker: poll feeds → announce new logs
└── moobie-app/          Astro app on Cloudflare (bot interactions + web UI; stages 2–3)
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
entries is a no-op.

Each genuinely new row is announced to every Discord channel in
`DISCORD_ANNOUNCE_CHANNEL_IDS` (config in `moobie-poll/wrangler.jsonc`), posted
as the bot with a rating-comparison card — poster, Letterboxd pfp, liked heart,
and anyone else's rating of the same film. A user's first ingest is a silent
seed, so `/track`-ing someone never floods the channel. Slash commands arrive
at the Astro app's Ed25519-verified `/interactions` endpoint.

## Local development

```sh
pnpm install

# apply the schema to the Worker's local D1
cd moobie-poll
pnpm db:local

# set a local key for the on-demand /poll trigger
cp .dev.vars.example .dev.vars

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
wrangler secret put TRIGGER_KEY
wrangler secret put DISCORD_BOT_TOKEN

# ship the cron Worker
pnpm deploy

# ship the Astro app (interactions + web)
cd ../moobie-app
pnpm deploy

# register / update slash commands (guild-scoped, instant)
DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
```

The D1 binding (`DB`) and database id are configured in both
`moobie-poll/wrangler.jsonc` and `moobie-app/wrangler.jsonc`.

## Status

Stages 1 and 2 are live: hourly announcements with comparison cards, and the
full command set (`/track`, `/untrack`, `/film`, `/film-key`, `/review`,
`/review-key`, `/best`, `/worst`, `/favorite`, `/stats`, `/refresh`) via the
Ed25519-verified `/interactions` endpoint. Next up is the simple web frontend (stage 3). CSV history import is
post-MVP. See PLAN.md for the stage-3 plan and the "Moving servers" runbook.
