// moobie-poll — the hourly cron Worker: for each active user, fetch their
// Letterboxd feed, insert anything new, and announce the genuinely-new rows to
// Discord as the bot. All real logic lives in @moobie/core; this file is the
// glue, plus delivery (core's embed builders stay pure of I/O).
//
// Idempotent and stateless (invariant #5): every insert is INSERT OR IGNORE on
// guid, so re-fetching is a no-op and a missed tick self-heals next run.
//
// Cron-only: no fetch handler, no public surface. Local testing fires the
// scheduled handler via `wrangler dev --test-scheduled` (see docs/operations.md).

import {
  buildEntryEmbed,
  compareFilm,
  compareRecency,
  countEntriesForUser,
  displayNameMap,
  getActiveUsers,
  getAvatarUrl,
  getEntriesByFilmKey,
  getRecentEntries,
  insertEntries,
  setUserAvatar,
  type DiscordEmbed,
  type EmbedContext,
  type LogEntry,
  type ParsedEntry,
  type TrackedUser,
} from "@moobie/core";

interface Env {
  DB: D1Database;
  DISCORD_BOT_TOKEN: string; // secret
  DISCORD_ANNOUNCE_CHANNEL_IDS: string; // plain var: comma-separated channel ids
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
};

/** Poll every active user once. Returns totals for the log line. */
async function poll(env: Env): Promise<PollSummary> {
  const users = await getActiveUsers(env.DB);
  const summary: PollSummary = { users: users.length, inserted: 0, announced: 0, seeded: [] };

  const displayNames = displayNameMap(users);

  for (const user of users) {
    const result = await pollUser(env, user, displayNames);
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

async function pollUser(
  env: Env,
  user: TrackedUser,
  displayNames: Record<string, string>,
): Promise<UserResult> {
  const username = user.username;

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
  const avatarUrl = await ensureAvatar(env.DB, user);
  let announced = 0;
  for (const entry of [...inserted].sort(compareRecency)) {
    announced += await announce(env, entry, { avatarUrl, displayNames });
  }
  return { inserted: inserted.length, announced, seeded: false };
}

/**
 * The user's Letterboxd pfp for embeds. Fetched from their profile the first
 * time it's needed, then served from the DB. Null (and retried next time) if
 * the profile fetch fails — avatars are cosmetic, never blocking.
 */
async function ensureAvatar(db: D1Database, user: TrackedUser): Promise<string | null> {
  if (user.avatar_url) return user.avatar_url;
  const fetched = await getAvatarUrl(user.username);
  if (fetched) await setUserAvatar(db, user.username, fetched);
  return fetched;
}

/** Announce one entry to every configured channel. Returns how many posts landed. */
async function announce(
  env: Env,
  entry: LogEntry,
  context: EmbedContext,
): Promise<number> {
  let embed;
  try {
    const filmEntries = await getEntriesByFilmKey(env.DB, entry.film_key);
    embed = buildEntryEmbed(entry, compareFilm(filmEntries), context);
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

const API_BASE = "https://discord.com/api/v10";

/**
 * POST one embed to a channel as the bot. Announcement bursts (one user logging
 * a stack of films) can trip Discord's per-channel rate limit; the 429 body
 * names its wait, so wait it out and retry once instead of dropping the
 * announcement. Throws on any other non-OK response, or a retry that still fails.
 */
async function sendChannelMessage(
  botToken: string,
  channelId: string,
  embed: DiscordEmbed,
): Promise<void> {
  let res = await postEmbed(botToken, channelId, embed);
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    const waitMs = Math.min(Math.max(body?.retry_after ?? 1, 0) * 1000, 10_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    res = await postEmbed(botToken, channelId, embed);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord ${res.status} posting to channel ${channelId}: ${body}`);
  }
}

function postEmbed(
  botToken: string,
  channelId: string,
  embed: DiscordEmbed,
): Promise<Response> {
  return fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
}
