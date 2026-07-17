# moobie-app

The Astro-on-Cloudflare deploy for moobie: Discord `/interactions` (stage 2) and
the simple web frontend + `/api/*` routes (stage 3). Not started yet — this is
the untouched Astro scaffold with the Cloudflare adapter.

See the repo root [`HANDOFF.md`](../HANDOFF.md) for the plan and invariants.
Key ones for this package:

- All shared logic comes from `@moobie/core` — no queries or analytics in here.
- D1 via the `DB` binding, `prerender = false` on any D1-touching endpoint.
- Ed25519 verification on the **raw body** in `/interactions`, before JSON parsing.
- Local dev must run under `wrangler dev` (the plain Astro dev server can't see D1).

## Commands

| Command        | Action                              |
| :------------- | :---------------------------------- |
| `pnpm install` | Install dependencies                |
| `pnpm dev`     | Start local dev server              |
| `pnpm build`   | Build production site to `./dist/`  |
| `pnpm preview` | Preview the build locally           |
