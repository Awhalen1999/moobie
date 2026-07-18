// moobie-poll — the hourly cron Worker. Its whole job: for each active user,
// fetch their Letterboxd diary, insert anything new, and announce the new rows
// to Discord as the bot. All real logic lives in @moobie/core; this file is just
// the glue that wires the shared functions to the cron trigger and the D1 binding.
//
// Idempotent and stateless (invariant #5): re-fetching the same ~50 entries is a
// no-op because every insert is INSERT OR IGNORE on guid, so a missed tick
// simply self-heals on the next run. No retry logic.
//
// Announcements broadcast to every channel in DISCORD_ANNOUNCE_CHANNEL_IDS —
// one pool of data, N places it speaks. Moving servers (or adding one) is a
// config edit, not a code change.
//
// A fetch handler is included purely so a poll can be run on demand (for testing
// and manual re-polls) without waiting for the top of the hour. It runs the exact
// same poll() as the cron and is guarded by the TRIGGER_KEY secret.

import {
  buildEntryEmbed,
  compareFilm,
  countEntriesForUser,
  getActiveUsers,
  getEntriesByFilmKey,
  getRecentEntries,
  insertEntries,
  sendChannelMessage,
  type LogEntry,
  type ParsedEntry,
} from "@moobie/core";

interface Env {
  DB: D1Database;
  DISCORD_BOT_TOKEN: string; // secret
  DISCORD_ANNOUNCE_CHANNEL_IDS: string; // plain var: comma-separated channel ids
  TRIGGER_KEY?: string; // secret
}

interface PollSummary {
  users: number;
  inserted: number;
  announced: number;
  seeded: string[]; // users whose backlog was silently seeded this run
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
  const summary: PollSummary = { users: users.length, inserted: 0, announced: 0, seeded: [] };

  for (const user of users) {
    const result = await pollUser(env, user.username);
    summary.inserted += result.inserted;
    summary.announced += result.announced;
    if (result.seeded) summary.seeded.push(user.username);
  }
  return summary;
}

interface UserResult {
  inserted: number;
  announced: number;
  seeded: boolean;
}

async function pollUser(env: Env, username: string): Promise<UserResult> {
  // If we hold nothing for this user yet, this is their first ingest: insert the
  // backlog but stay quiet, so adding a user doesn't flood the channels with
  // ~50 posts. Announcements start on the next poll, for genuinely new logs.
  const seeding = (await countEntriesForUser(env.DB, username)) === 0;

  let entries: ParsedEntry[];
  try {
    entries = await getRecentEntries(username);
  } catch (err) {
    // One unreachable or malformed feed must not stop the other users.
    console.error(`moobie-poll: fetch failed for "${username}":`, err);
    return { inserted: 0, announced: 0, seeded: false };
  }

  const inserted = await insertEntries(env.DB, entries);
  if (seeding || inserted.length === 0) {
    return { inserted: inserted.length, announced: 0, seeded: seeding };
  }

  // Post oldest first, so the channels read in the order films were watched.
  let announced = 0;
  for (const entry of [...inserted].sort(byWatchedAscending)) {
    announced += await announce(env, entry);
  }
  return { inserted: inserted.length, announced, seeded: false };
}

/** Announce one entry to every configured channel. Returns how many posts landed. */
async function announce(env: Env, entry: LogEntry): Promise<number> {
  let embed;
  try {
    const filmEntries = await getEntriesByFilmKey(env.DB, entry.film_key);
    embed = buildEntryEmbed(entry, compareFilm(filmEntries));
  } catch (err) {
    console.error(`moobie-poll: comparison failed for ${entry.guid}:`, err);
    return 0;
  }

  let posted = 0;
  for (const channelId of announceChannels(env)) {
    try {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, embed);
      posted++;
    } catch (err) {
      // A failed post drops one announcement (the row is already saved); log and
      // keep going rather than abandon the remaining channels or entries.
      console.error(`moobie-poll: announce failed for ${entry.guid} -> ${channelId}:`, err);
    }
  }
  return posted;
}

function announceChannels(env: Env): string[] {
  return (env.DISCORD_ANNOUNCE_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function byWatchedAscending(a: LogEntry, b: LogEntry): number {
  const da = a.watched_date ?? "";
  const db = b.watched_date ?? "";
  if (da !== db) return da < db ? -1 : 1;
  return a.guid < b.guid ? -1 : 1;
}
