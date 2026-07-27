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
├── moobie-app/          Astro app: /interactions (slash commands) + the site
└── docs/                architecture, operations, language, web style
```

Both deploys import `@moobie/core`, so every query, parser, and card exists
exactly once. The docs: [architecture](./docs/architecture.md) (data model,
invariants, status), [operations](./docs/operations.md) (dev, deploy,
runbooks), [language](./docs/language.md) (vocabulary and voice),
[style](./docs/style.md) (the web design system).

## Running it

**The website** — one command, from anywhere in the repo:

```sh
pnpm install
pnpm dev          # → http://localhost:4321, hot reload, local D1
```

Dev uses wrangler's local D1 state (the adapter proxies the binding), so it
never touches production data. Seeding it, running the poll Worker locally,
deploying, secrets — all in [operations](./docs/operations.md).
