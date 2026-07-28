# decisions

- two tables. film data lives denormalized on `log_entries` — no films table.
- every write is `INSERT OR IGNORE` on a unique key, so re-running anything is a no-op.
- data comes from each person's public letterboxd rss feed. no api, nothing past the feed.
- `film_key` is the film's letterboxd url slug — groups a film across users better than title + year.
- analytics are pure functions. the bot and the site call the same ones.
- tracking someone ingests their backlog quietly — announcements start with their next log.
- feeds are checked every 30 minutes.
- the poll worker is cron-only: no routes, no public url, one secret (the bot token).
- discord requests are ed25519-verified on the raw body before anything is parsed.
- announcements post as the bot, never through channel webhooks.
- slash commands are guild-scoped so updates land instantly.
- `/vs` and `/refresh` were cut. both live in git history.
- editing a log on letterboxd renames its guid, so it re-announces once. accepted.
- typescript is pinned to 6 in the app until `astro check` supports 7.
- no cache headers on `/api/graph` yet — friend-group traffic doesn't need them.

## todo

- people and stats pages
- site navigation
- csv import for history from before tracking started

## running it

- `pnpm install`, then `pnpm dev` — local site with local d1.
- seed the local db from `moobie-app/`: `pnpm exec wrangler d1 execute moobie --local --file=../db/schema.sql`
- deploy: `pnpm run deploy` from `moobie-app/` and `moobie-poll/` — both, when `packages/core` changed.
- secrets go in with `wrangler secret put`, never the repo.
- commands re-register with `node scripts/register-commands.mjs` (needs `DISCORD_BOT_TOKEN`).
