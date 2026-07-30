// moobie-poll — the cron Worker. Every 30 minutes: fetch each tracked
// Letterboxd feed, save anything new, announce it to Discord as the bot.
// The logic lives in @moobie/core; this file is glue plus delivery.
//
// Inserts are INSERT OR IGNORE on guid, so re-fetching is a no-op and a missed
// tick heals itself on the next one. Cron-only — no fetch handler, no public
// URL. Run it locally with `wrangler dev --test-scheduled`.

import {
  buildEntryCard,
  compareFilm,
  compareRecency,
  countEntriesForUser,
  displayNameMap,
  getActiveUsers,
  getAvatarUrl,
  getEntriesByFilmKey,
  getRecentEntries,
  insertEntries,
  IS_COMPONENTS_V2,
  setUserAvatar,
  type Container,
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

  // First ingest for this user: save their backlog quietly, so tracking
  // someone doesn't flood the channel. Announcements start with their next log.
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
 * The user's Letterboxd pfp, fetched once and then served from the DB.
 * Null if the fetch fails (retried next time) — avatars are cosmetic.
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
  let card;
  try {
    const filmEntries = await getEntriesByFilmKey(env.DB, entry.film_key);
    card = buildEntryCard(entry, compareFilm(filmEntries), context);
  } catch (err) {
    console.error(`moobie-poll: comparison failed for ${entry.guid}:`, err);
    return 0;
  }

  let posted = 0;
  for (const channelId of announceChannels(env)) {
    try {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, card);
      posted++;
    } catch (err) {
      // The row is already saved; log the miss and keep going.
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
 * POST one card to a channel as the bot. A burst of announcements can trip
 * Discord's rate limit; the 429 says how long to wait, so wait and retry once.
 * Throws if the response still isn't OK.
 */
async function sendChannelMessage(
  botToken: string,
  channelId: string,
  card: Container,
): Promise<void> {
  let res = await postCard(botToken, channelId, card);
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    const waitMs = Math.min(Math.max(body?.retry_after ?? 1, 0) * 1000, 10_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    res = await postCard(botToken, channelId, card);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord ${res.status} posting to channel ${channelId}: ${body}`);
  }
}

function postCard(
  botToken: string,
  channelId: string,
  card: Container,
): Promise<Response> {
  return fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ flags: IS_COMPONENTS_V2, components: [card] }),
  });
}
