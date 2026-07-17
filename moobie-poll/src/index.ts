// moobie-poll — the hourly cron Worker. Its whole job: for each active user,
// fetch their Letterboxd diary and insert anything new. All real logic lives in
// @moobie/core; this file is just the glue that wires the shared functions to
// the cron trigger and the D1 binding.
//
// Idempotent and stateless (invariant #5): re-fetching the same ~50 entries is a
// no-op because every insert is INSERT OR IGNORE on guid, so a missed tick
// simply self-heals on the next run. No retry logic.
//
// Announcing new rows to Discord is stage 2 (the bot). Until then the poll is
// ingest-only, which also means the whole backlog is quietly in the DB before
// the bot ever comes online — no first-announcement flood.
//
// A fetch handler is included purely so a poll can be run on demand (for testing
// and manual re-polls) without waiting for the top of the hour. It runs the exact
// same poll() as the cron and is guarded by the TRIGGER_KEY secret.

import {
  getActiveUsers,
  getRecentEntries,
  insertEntries,
  type ParsedEntry,
} from "@moobie/core";

interface Env {
  DB: D1Database;
  TRIGGER_KEY?: string;
}

interface PollSummary {
  users: number;
  inserted: number;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const summary = await poll(env);
    console.log("moobie-poll:", JSON.stringify(summary));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/poll") {
      return new Response("moobie-poll is alive. GET /poll?key=... to run a poll.");
    }
    if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY) {
      return new Response("unauthorized", { status: 401 });
    }
    const summary = await poll(env);
    return Response.json(summary);
  },
};

/** Poll every active user once. Returns totals for logging / the trigger. */
async function poll(env: Env): Promise<PollSummary> {
  const users = await getActiveUsers(env.DB);
  let inserted = 0;
  for (const user of users) {
    inserted += await pollUser(env, user.username);
  }
  return { users: users.length, inserted };
}

/** Fetch one user's diary and insert what's new. Returns the new-row count. */
async function pollUser(env: Env, username: string): Promise<number> {
  let entries: ParsedEntry[];
  try {
    entries = await getRecentEntries(username);
  } catch (err) {
    // One unreachable or malformed feed must not stop the other users.
    console.error(`moobie-poll: fetch failed for "${username}":`, err);
    return 0;
  }
  const inserted = await insertEntries(env.DB, entries);
  return inserted.length;
}
