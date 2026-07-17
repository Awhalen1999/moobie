// moobie-poll — the hourly cron Worker. Its whole job: for each active user,
// fetch their Letterboxd diary, insert anything new, and announce the new rows
// to Discord. All real logic lives in @moobie/core; this file is just the glue
// that wires the shared functions to the cron trigger and the D1 binding.
//
// Idempotent and stateless (invariant #5): re-fetching the same ~50 entries is a
// no-op because every insert is INSERT OR IGNORE on guid, so a missed tick
// simply self-heals on the next run. No retry logic.

import {
  compareFilm,
  countEntriesForUser,
  getActiveUsers,
  getEntriesByFilmKey,
  getRecentEntries,
  insertEntries,
  announceEntry,
  type LogEntry,
  type ParsedEntry,
} from "@moobie/core";

interface Env {
  DB: D1Database;
  DISCORD_WEBHOOK_URL: string;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const users = await getActiveUsers(env.DB);
    for (const user of users) {
      await pollUser(env, user.username);
    }
  },
};

async function pollUser(env: Env, username: string): Promise<void> {
  // If we hold nothing for this user yet, this is their first ingest: insert the
  // backlog but stay quiet, so adding a user doesn't flood the channel with
  // ~50 posts. Announcements start on the next poll, for genuinely new logs.
  const seeding = (await countEntriesForUser(env.DB, username)) === 0;

  let entries: ParsedEntry[];
  try {
    entries = await getRecentEntries(username);
  } catch (err) {
    // One unreachable or malformed feed must not stop the other users.
    console.error(`moobie-poll: fetch failed for "${username}":`, err);
    return;
  }

  const inserted = await insertEntries(env.DB, entries);
  if (seeding || inserted.length === 0) return;

  // Post oldest first, so the channel reads in the order films were watched.
  for (const entry of [...inserted].sort(byWatchedAscending)) {
    await announce(env, entry);
  }
}

async function announce(env: Env, entry: LogEntry): Promise<void> {
  try {
    const filmEntries = await getEntriesByFilmKey(env.DB, entry.film_key);
    const comparison = compareFilm(filmEntries);
    await announceEntry(env.DISCORD_WEBHOOK_URL, entry, comparison);
  } catch (err) {
    // A failed post drops one announcement (the row is already saved); log and
    // keep going rather than abandon the remaining new entries.
    console.error(`moobie-poll: announce failed for ${entry.guid}:`, err);
  }
}

function byWatchedAscending(a: LogEntry, b: LogEntry): number {
  const da = a.watched_date ?? "";
  const db = b.watched_date ?? "";
  if (da !== db) return da < db ? -1 : 1;
  return a.guid < b.guid ? -1 : 1;
}
