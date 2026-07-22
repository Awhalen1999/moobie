// Discord interactions endpoint — the bot's inbound half. Discord POSTs every
// slash command here; we verify the Ed25519 signature on the RAW body before
// any JSON parsing (invariant #7), then route on the command name.
//
// /track and /refresh do network work, so they use Discord's deferred reply:
// respond "thinking…" within the 3-second window, finish via waitUntil, then
// edit the reply. Everything else answers directly.

import type { APIRoute } from "astro";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import {
  addTrackedUser,
  bestFilms,
  buildEntryEmbed,
  buildFavoritesEmbed,
  buildFilmEmbed,
  buildStatsEmbed,
  buildSuperlativeEmbed,
  compareFilm,
  deactivateTrackedUser,
  displayNameMap,
  favoriteFilms,
  filmTitle,
  findFilm,
  getAllTrackedUsers,
  getAvatarUrl,
  getEntriesByFilmKey,
  getEntriesForUser,
  getFilmCatalog,
  getGroupStats,
  getRecentEntries,
  getUserStats,
  insertEntries,
  worstFilms,
  type DiscordEmbed,
  type EmbedContext,
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
      case "review":
        return review(interaction);
      case "review-key":
        return reviewKey(interaction);
      case "best":
        return best(interaction);
      case "worst":
        return worst(interaction);
      case "favorite":
        return favorite(interaction);
      case "stats":
        return stats(interaction);
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
    return msg(`\`${username ?? ""}\` doesn't look like a Letterboxd username.`);
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
    const existing = (await getAllTrackedUsers(env.DB)).find((u) => u.username === username);
    const entries = await getRecentEntries(username); // throws if the feed 404s
    const avatarUrl = await getAvatarUrl(username);
    await addTrackedUser(env.DB, username, { displayName, avatarUrl });
    const inserted = await insertEntries(env.DB, entries);

    const shown = displayName ?? existing?.display_name ?? username;
    const profile = `[letterboxd.com/${username}](https://letterboxd.com/${username}/)`;

    if (existing?.active) {
      content = `**${shown}** is already tracked (${profile}).${displayName ? " Details updated." : ""}`;
    } else if (existing) {
      content = `🎬 Tracking **${shown}** again (${profile}). New logs will be announced.`;
    } else {
      const stored =
        inserted.length > 0
          ? `Stored ${inserted.length} recent ${inserted.length === 1 ? "log" : "logs"} quietly - new ones will be announced.`
          : "Nothing in their feed yet - new logs will be announced.";
      content = `🎬 Now tracking **${shown}** (${profile}). ${stored}`;
    }
  } catch (err) {
    // Reply stays friendly; the real error goes to the logs for forensics.
    console.error(`moobie-app: /track failed for "${username}":`, err);
    content =
      `Couldn't read \`letterboxd.com/${username}/rss/\` - ` +
      `check the spelling, and that their Letterboxd feed is public.`;
  }
  await editReply(interaction, content);
}

/** /untrack <username> — stop polling and announcing; history stays. */
async function untrack(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const removed = await deactivateTrackedUser(env.DB, username);
  return msg(
    removed
      ? `👋 Stopped tracking **${username}**.`
      : `**${username}** isn't tracked.`,
  );
}

/**
 * /film <title> — how everyone rated one film. Forgiving search: case,
 * punctuation, and spacing don't matter (findFilm normalizes both sides).
 */
async function film(interaction: Interaction): Promise<Response> {
  const query = option(interaction, "title")?.trim();
  if (!query) return msg("Give me a film title to look up.");

  const match = findFilm(await getFilmCatalog(env.DB), query);
  if (!match) return msg(noMatch(query, "/film-key"));
  return filmCard(match.film_key);
}

/** /film-key <key> — exact lookup by the film's Letterboxd URL slug. */
async function filmKey(interaction: Interaction): Promise<Response> {
  const key = option(interaction, "key")?.trim().toLowerCase().replace(/\//g, "");
  if (!key) return msg("Give me a film key to look up.");
  return filmCard(key, keyNotFound(key));
}

/** The shared /film + /film-key reply: comparison card for one film_key. */
async function filmCard(key: string, notFound?: string): Promise<Response> {
  const comparison = compareFilm(await getEntriesByFilmKey(env.DB, key));
  if (!comparison) {
    return msg(notFound ?? "Nobody's logged that yet.");
  }
  return embeds(buildFilmEmbed(comparison, { displayNames: await displayNames() }));
}

/**
 * /review <username> <title> — one person's latest log of a film: rating,
 * heart, and their review. Same forgiving title search as /film.
 */
async function review(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const query = option(interaction, "title")?.trim();
  if (!query) return msg("Give me a film title to look up.");

  const match = findFilm(await getFilmCatalog(env.DB), query);
  if (!match) return msg(noMatch(query, "/review-key"));
  return reviewCard(username, match.film_key);
}

/** /review-key <username> <key> — same card, exact lookup by URL slug. */
async function reviewKey(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const key = option(interaction, "key")?.trim().toLowerCase().replace(/\//g, "");
  if (!key) return msg("Give me a film key to look up.");
  return reviewCard(username, key, keyNotFound(key));
}

/** The shared /review + /review-key reply: one user's latest log of one film. */
async function reviewCard(
  username: string,
  key: string,
  notFound?: string,
): Promise<Response> {
  const entries = await getEntriesByFilmKey(env.DB, key);
  const comparison = compareFilm(entries);
  if (!comparison) return msg(notFound ?? "Nobody's logged that yet.");

  // Rows arrive newest-first (the query orders them), so the first hit wins.
  const latest = entries.find((e) => e.username === username);
  if (!latest) {
    return msg(`**${username}** hasn't logged **${filmTitle(comparison)}**.`);
  }

  return embeds(buildEntryEmbed(latest, comparison, await userContext(username)));
}

/** Shared miss copy for the title-search commands (/film, /review). */
function noMatch(query: string, keyCommand: string): string {
  return (
    `Nobody's logged anything matching “${query}” yet. ` +
    `If it should be there, try \`${keyCommand}\` with the slug from the film's Letterboxd URL.`
  );
}

/** Shared miss copy for the exact-key commands (/film-key, /review-key). */
function keyNotFound(key: string): string {
  return `No logs for \`${key}\` yet. The key is the slug in the film's Letterboxd URL: letterboxd.com/film/**the-key**/`;
}

/** /best <username> — the films a person rated highest. */
async function best(interaction: Interaction): Promise<Response> {
  return superlativeCard(interaction, "best");
}

/** /worst <username> — the films a person rated lowest. */
async function worst(interaction: Interaction): Promise<Response> {
  return superlativeCard(interaction, "worst");
}

/** The shared /best + /worst reply: featured poster plus any tied films. */
async function superlativeCard(
  interaction: Interaction,
  kind: "best" | "worst",
): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const entries = await getEntriesForUser(env.DB, username);
  if (entries.length === 0) return msg(`No logs for **${username}** yet.`);

  const superlative = (kind === "best" ? bestFilms : worstFilms)(entries);
  if (!superlative) return msg(`**${username}** hasn't rated anything yet.`);

  return embeds(buildSuperlativeEmbed(kind, superlative, await userContext(username)));
}

/** /favorite <username> — every film a person has liked, with their ratings. */
async function favorite(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const entries = await getEntriesForUser(env.DB, username);
  if (entries.length === 0) return msg(`No logs for **${username}** yet.`);

  const favorites = favoriteFilms(entries);
  if (favorites.length === 0) return msg(`**${username}** hasn't liked anything yet.`);

  return embeds(buildFavoritesEmbed(favorites, await userContext(username)));
}

/** /stats [username] — one person's numbers, or the whole group's. */
async function stats(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase();
  const names = await displayNames();

  if (username) {
    const userStats = await getUserStats(env.DB, username);
    if (!userStats) return msg(`No logs for **${username}** yet.`);
    return embeds(buildStatsEmbed([userStats], { displayNames: names }));
  }

  const group = await getGroupStats(env.DB);
  if (group.length === 0) return msg("Nothing logged yet - `/track` someone first.");
  return embeds(buildStatsEmbed(group, { displayNames: names }));
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
    const feeds = s.users === 1 ? "feed" : "feeds";
    content =
      s.inserted === 0
        ? `✅ Checked ${s.users} ${feeds} - nothing new.`
        : `✅ Checked ${s.users} ${feeds} - ${s.inserted} new, ${s.announced} announced.`;
  } catch (err) {
    console.error("moobie-app: /refresh failed:", err);
    content = "Couldn't run the refresh - try again in a minute.";
  }
  await editReply(interaction, content);
}

// --- plumbing ---------------------------------------------------------------

/** username -> display name for everyone ever tracked (fallback: username). */
async function displayNames(): Promise<Record<string, string>> {
  return displayNameMap(await getAllTrackedUsers(env.DB));
}

/** Card context for one person's cards: their avatar, plus everyone's names. */
async function userContext(username: string): Promise<EmbedContext> {
  const users = await getAllTrackedUsers(env.DB);
  return {
    avatarUrl: users.find((u) => u.username === username)?.avatar_url ?? null,
    displayNames: displayNameMap(users),
  };
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
