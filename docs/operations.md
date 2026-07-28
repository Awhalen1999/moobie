# Operations

## Local dev

**The website** — from anywhere in the repo:

```sh
pnpm install
pnpm dev          # → http://localhost:4321, hot reload, local D1
```

Dev uses wrangler's local D1 state (the Cloudflare adapter proxies the `DB`
binding from `wrangler.jsonc`), so it never touches production. Seed it from
`moobie-app/`:

```sh
pnpm exec wrangler d1 execute moobie --local --file=../db/schema.sql
pnpm exec wrangler d1 export moobie --remote --output=dump.sql   # optional: copy prod
pnpm exec wrangler d1 execute moobie --local --file=dump.sql
```

**The poll Worker** (rarely needed locally):

```sh
cd moobie-poll
pnpm db:local
cp .dev.vars.example .dev.vars
pnpm dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"   # fire the cron now
```

## Deploy

`pnpm run deploy` from each of `moobie-app/` and `moobie-poll/` (`run` is
required — bare `pnpm deploy` hits pnpm's unrelated built-in command). Both
bundle their own copy of `@moobie/core`, so **shared-code changes need both
deploys**.
The website is frozen until it's called ready; the bot ships independently.

Slash commands re-register with:

```sh
DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
```

Guild-scoped, instant; the PUT replaces the whole set, so re-run it after any
command definition change.

## Secrets & config

Secrets go in with `wrangler secret put`, never into the repo.

| secret              | where       | why                            |
|---------------------|-------------|--------------------------------|
| `DISCORD_BOT_TOKEN` | poll Worker | posts announcements as the bot |

Plain vars (in `wrangler.jsonc`):

- `DISCORD_PUBLIC_KEY` (app) — verifies Ed25519 on `/interactions`.
- `DISCORD_ANNOUNCE_CHANNEL_IDS` (poll) — comma-separated channel ids; one
  data pool broadcast to N channels, can span servers.

Script-side: the app ID is hardcoded in `scripts/register-commands.mjs` (a
public identifier); `DISCORD_GUILD_ID` defaults to moobie's home server with
an env override.

## Backups

D1's Time Travel keeps automatic point-in-time restore (30 days on paid, 7 on
free) — `wrangler d1 time-travel` from `moobie-app/` or `moobie-poll/`. For a
copy that outlives that window, dump occasionally:

```sh
pnpm exec wrangler d1 export moobie --remote --output=backup.sql
```

## Moving servers (runbook)

One data pool; servers are just places moobie speaks.

1. **Invite the bot** — OAuth URL (App ID + `bot applications.commands` scopes
   + View Channels / Send Messages / Embed Links). Private bot: only the owner
   can authorize, and needs Manage Server in the target.
2. **Announce target** — edit `DISCORD_ANNOUNCE_CHANNEL_IDS` in
   `moobie-poll/wrangler.jsonc` (add for both, replace to move), then
   `wrangler deploy` from `moobie-poll/`.
3. **Slash commands** — `DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=<new server>
   node scripts/register-commands.mjs`.
4. Optionally kick the bot from the old server. Nothing else changes: DB,
   token, public key, app ID, and the app deploy are all server-agnostic.
