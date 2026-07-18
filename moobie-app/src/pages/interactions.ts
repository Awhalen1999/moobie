// Discord interactions endpoint — the bot's inbound half. Discord POSTs every
// slash command here; we verify the Ed25519 signature on the RAW body before
// any JSON parsing (invariant #7), then route on the command name.
//
// /track runs network fetches (RSS + avatar), so it uses Discord's deferred
// reply: respond "thinking…" within the 3-second window, finish the work via
// waitUntil, then edit the reply. /untrack is one UPDATE and answers directly.

import type { APIRoute } from "astro";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import {
  addTrackedUser,
  buildFilmEmbed,
  compareFilm,
  compareUsers,
  deactivateTrackedUser,
  getAllTrackedUsers,
  getAvatarUrl,
  getEntriesByFilmKey,
  getEntriesForUser,
  getGroupStats,
  findFilm,
  getFilmCatalog,
  getRecentEntries,
  getUserStats,
  insertEntries,
  stars,
  type DiscordEmbed,
  type UserStats,
} from "@moobie/core";

export const prerender = false;

// Discord interaction / response type constants (the subset we use).
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED_MESSAGE = 5;

interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  MOOBIE_POLL_URL: string; // the poll Worker, for /refresh
  TRIGGER_KEY: string; // secret shared with the poll Worker
}

const env = workerEnv as unknown as Env;

interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: {
    name: string;
    options?: { name: string; value: string }[];
  };
}

export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (
    !signature ||
    !timestamp ||
    !(await verifySignature(env.DISCORD_PUBLIC_KEY, signature, timestamp + body))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction: Interaction = JSON.parse(body);

  if (interaction.type === PING) return json({ type: PONG });

  if (interaction.type === APPLICATION_COMMAND) {
    switch (interaction.data?.name) {
      case "track":
        return track(interaction);
      case "untrack":
        return untrack(interaction);
      case "film":
        return film(interaction);
      case "film-key":
        return filmKey(interaction);
      case "stats":
        return statsCommand(interaction);
      case "vs":
        return versus(interaction);
      case "refresh":
        return refresh(interaction);
    }
  }

  return msg("moobie doesn't know that one.");
};

// --- commands --------------------------------------------------------------

/**
 * /track <username> [display_name] — start tracking a Letterboxd diary.
 * Defers, then: validate the feed, grab the avatar, upsert the user, and seed
 * their backlog silently (so the next poll only announces genuinely new logs).
 */
function track(interaction: Interaction): Response {
  const username = option(interaction, "username")?.trim().toLowerCase();
  const displayName = option(interaction, "display_name")?.trim() || null;

  if (!username || !/^[a-z0-9_]+$/.test(username)) {
    return json({
      type: MESSAGE,
      data: { content: `\`${username ?? ""}\` doesn't look like a Letterboxd username.` },
    });
  }

  waitUntil(finishTrack(interaction, username, displayName));
  return json({ type: DEFERRED_MESSAGE });
}

async function finishTrack(
  interaction: Interaction,
  username: string,
  displayName: string | null,
): Promise<void> {
  let content: string;
  try {
    const entries = await getRecentEntries(username); // throws if the feed 404s
    const avatarUrl = await getAvatarUrl(username);
    await addTrackedUser(env.DB, username, { displayName, avatarUrl });
    const inserted = await insertEntries(env.DB, entries);

    const shown = displayName ?? username;
    content =
      `🎬 Now tracking **${shown}** (` +
      `[letterboxd.com/${username}](https://letterboxd.com/${username}/)). ` +
      `Stored ${inserted.length} recent ${inserted.length === 1 ? "entry" : "entries"} quietly - ` +
      `new logs will be announced automatically.`;
  } catch (err) {
    // Reply stays friendly; the real error goes to the logs for forensics.
    console.error(`moobie-app: /track failed for "${username}":`, err);
    content =
      `Couldn't read \`letterboxd.com/${username}/rss/\` - ` +
      `check the spelling, and that the account's diary is public.`;
  }
  await editReply(interaction, content);
}

/** /untrack <username> — stop polling and announcing; history stays. */
async function untrack(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const removed = await deactivateTrackedUser(env.DB, username);
  return json({
    type: MESSAGE,
    data: {
      content: removed
        ? `👋 Stopped tracking **${username}**.`
        : `**${username}** isn't currently tracked.`,
    },
  });
}

/**
 * /film <title> — how everyone rated one film. Forgiving search: case,
 * punctuation, and spacing don't matter (findFilm normalizes both sides).
 */
async function film(interaction: Interaction): Promise<Response> {
  const query = option(interaction, "title")?.trim();
  if (!query) return msg("Give me a film title to look up.");

  const match = findFilm(await getFilmCatalog(env.DB), query);
  if (!match) {
    return msg(
      `Nobody's logged anything matching “${query}” yet. ` +
        `If it should be there, try \`/film-key\` with the slug from the film's Letterboxd URL.`,
    );
  }
  return filmCard(match.film_key);
}

/** /film-key <key> — exact lookup by the film's Letterboxd URL slug. */
async function filmKey(interaction: Interaction): Promise<Response> {
  const key = option(interaction, "key")?.trim().toLowerCase().replace(/\//g, "");
  if (!key) return msg("Give me a film key to look up.");
  return filmCard(
    key,
    `No logs for \`${key}\`. The key is the slug in the film's Letterboxd URL: letterboxd.com/film/**the-key**/`,
  );
}

/** The shared /film + /film-key reply: comparison card for one film_key. */
async function filmCard(filmKeyValue: string, notFound?: string): Promise<Response> {
  const comparison = compareFilm(await getEntriesByFilmKey(env.DB, filmKeyValue));
  if (!comparison) {
    return msg(notFound ?? "Nobody's logged that yet.");
  }
  return embeds(buildFilmEmbed(comparison, { displayNames: await displayNames() }));
}

/** /stats [username] — one person's numbers, or the whole group's. */
async function statsCommand(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase();
  const names = await displayNames();

  if (username) {
    const userStats = await getUserStats(env.DB, username);
    if (!userStats) return msg(`No entries for **${username}** yet.`);
    return embeds({
      title: `${names[username] ?? username} - stats`,
      description: statsLine(userStats),
      color: MOOBIE_GREEN,
    });
  }

  const group = await getGroupStats(env.DB);
  if (group.length === 0) return msg("Nothing logged yet - `/track` someone first.");
  return embeds({
    title: "moobie stats",
    description: group
      .map((s) => `**${names[s.username] ?? s.username}**\n${statsLine(s)}`)
      .join("\n\n"),
    color: MOOBIE_GREEN,
  });
}

// Em-spaces separate the stats — same visual rhythm as the rating rows on cards.
function statsLine(s: UserStats): string {
  const avg = s.average !== null ? `⭐ avg ${s.average}` : "⭐ nothing rated";
  return [`${s.films} films`, avg, `❤️ ${s.liked}`, `🔁 ${s.rewatches}`].join("\u2003");
}

/** /vs <user1> <user2> — head-to-head taste comparison. */
async function versus(interaction: Interaction): Promise<Response> {
  const u1 = option(interaction, "user1")?.trim().toLowerCase() ?? "";
  const u2 = option(interaction, "user2")?.trim().toLowerCase() ?? "";
  if (u1 === u2) return msg("That's just one person agreeing with themselves.");

  const [a, b] = await Promise.all([
    getEntriesForUser(env.DB, u1),
    getEntriesForUser(env.DB, u2),
  ]);
  if (a.length === 0) return msg(`No entries for **${u1}** yet.`);
  if (b.length === 0) return msg(`No entries for **${u2}** yet.`);

  const names = await displayNames();
  const nameA = names[u1] ?? u1;
  const nameB = names[u2] ?? u2;

  const h = compareUsers(a, b);
  if (h.shared === 0) {
    return msg(`**${nameA}** and **${nameB}** have no films in common yet.`);
  }

  const lines = [`🎬 **${h.shared}** films in common - **${h.bothRated}** rated by both`];
  if (h.agreementPct !== null) {
    lines.push(`🤝 within one star on **${h.agreementPct}%** · average gap **${h.avgGap}**`);
  }

  const embed: DiscordEmbed = {
    title: `${nameA} vs ${nameB}`,
    description: lines.join("\n"),
    color: h.biggest && h.biggest.gap >= 1.5 ? 0xff8000 : MOOBIE_GREEN,
  };
  if (h.biggest && h.biggest.gap > 0) {
    const filmName = h.biggest.film_year
      ? `${h.biggest.film_title} (${h.biggest.film_year})`
      : h.biggest.film_title;
    embed.fields = [
      {
        name: "Biggest disagreement",
        value: `**${filmName}** - ${nameA} ${stars(h.biggest.a)} vs ${nameB} ${stars(h.biggest.b)}`,
      },
    ];
  }
  return embeds(embed);
}

/** /refresh — run a poll right now instead of waiting for the top of the hour. */
function refresh(interaction: Interaction): Response {
  waitUntil(finishRefresh(interaction));
  return json({ type: DEFERRED_MESSAGE });
}

async function finishRefresh(interaction: Interaction): Promise<void> {
  let content: string;
  try {
    const res = await fetch(`${env.MOOBIE_POLL_URL}/poll?key=${env.TRIGGER_KEY}`);
    if (!res.ok) throw new Error(`poll trigger ${res.status}`);
    const s = (await res.json()) as { users: number; inserted: number; announced: number };
    const diaries = s.users === 1 ? "diary" : "diaries";
    content =
      s.inserted === 0
        ? `✅ Checked ${s.users} ${diaries} - nothing new.`
        : `✅ Checked ${s.users} ${diaries} - ${s.inserted} new, ${s.announced} announced.`;
  } catch (err) {
    console.error("moobie-app: /refresh failed:", err);
    content = "Couldn't reach the poll Worker - try again in a minute.";
  }
  await editReply(interaction, content);
}

// --- plumbing ---------------------------------------------------------------

const MOOBIE_GREEN = 0x00e054;

/** username -> display name for everyone ever tracked (fallback: username). */
async function displayNames(): Promise<Record<string, string>> {
  const users = await getAllTrackedUsers(env.DB);
  return Object.fromEntries(users.map((u) => [u.username, u.display_name ?? u.username]));
}

function msg(content: string): Response {
  return json({ type: MESSAGE, data: { content } });
}

function embeds(...list: DiscordEmbed[]): Response {
  return json({ type: MESSAGE, data: { embeds: list } });
}

/** Verify Discord's Ed25519 signature over timestamp+rawBody (WebCrypto). */
async function verifySignature(
  publicKeyHex: string,
  signatureHex: string,
  message: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function option(interaction: Interaction, name: string): string | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

/** Edit the deferred "thinking…" reply. Auth is the interaction token itself. */
async function editReply(interaction: Interaction, content: string): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
