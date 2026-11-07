// The bot's inbound half. Discord POSTs every slash command here; the Ed25519
// signature is verified on the raw body before any JSON parsing, then the
// command name picks a handler.
//
// /track does network work, so it uses Discord's deferred reply: answer
// "thinking…" inside the 3-second window, finish via waitUntil, edit the
// reply. Everything else answers directly.

import type { APIRoute } from "astro";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import {
  addRecommendation,
  addTrackedUser,
  bestFilms,
  buildEntryCard,
  buildFavoritesCard,
  buildFilmCard,
  buildRecCard,
  buildStatsCard,
  buildSuperlativeCard,
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
  getRecommendations,
  getRecommendationsByKey,
  getUserStats,
  insertEntries,
  groupRecs,
  IS_COMPONENTS_V2,
  listNames,
  normalizeTitle,
  removeRecommendation,
  worstFilms,
  type Container,
  type EmbedContext,
  type Recommendation,
  type Recommender,
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
}

const env = workerEnv as unknown as Env;

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

interface Interaction {
  type: number;
  application_id: string;
  token: string;
  // Who ran the command, as Discord says - the body is signed, so this is
  // trustworthy. `member` in a server (with their nickname), `user` in a DM.
  member?: { nick?: string | null; user: DiscordUser };
  user?: DiscordUser;
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
      case "rec":
        return rec(interaction);
      case "rec-film":
        return recFilm();
      case "unrec":
        return unrec(interaction);
    }
  }

  return msg("moobie doesn't know that one.");
};

// --- commands --------------------------------------------------------------

/**
 * /track <username> [display_name] — start tracking a feed. Defers, then:
 * validate the feed, grab the avatar, upsert the user, seed their backlog
 * quietly so only genuinely new logs get announced.
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
    // The reply stays friendly; the real error goes to the logs.
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
 * punctuation, and spacing don't matter.
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
  return components(buildFilmCard(comparison, { displayNames: await displayNames() }));
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

  // Rows arrive newest-first, so the first hit is their latest log.
  const latest = entries.find((e) => e.username === username);
  if (!latest) {
    return msg(`**${username}** hasn't logged **${filmTitle(comparison)}**.`);
  }

  return components(buildEntryCard(latest, comparison, await userContext(username)));
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

  return components(buildSuperlativeCard(kind, superlative, await userContext(username)));
}

/** /favorite <username> — every film a person has liked, with their ratings. */
async function favorite(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const entries = await getEntriesForUser(env.DB, username);
  if (entries.length === 0) return msg(`No logs for **${username}** yet.`);

  const favorites = favoriteFilms(entries);
  if (favorites.length === 0) return msg(`**${username}** hasn't liked anything yet.`);

  return components(buildFavoritesCard(favorites, await userContext(username)));
}

/** /stats [username] — one person's numbers, or the whole group's. */
async function stats(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase();

  if (username) {
    const userStats = await getUserStats(env.DB, username);
    if (!userStats) return msg(`No logs for **${username}** yet.`);
    return components(buildStatsCard([userStats], await userContext(username)));
  }

  const group = await getGroupStats(env.DB);
  if (group.length === 0) return msg("Nothing logged yet - `/track` someone first.");
  return components(buildStatsCard(group, { displayNames: await displayNames() }));
}

/**
 * /rec <title> — put a film on the pool's recs. The recommender is whoever
 * ran the command; nobody types a name. One rec per film per person: a second
 * person stacks on the film, the same person again is a no-op. Replies are
 * flat statements - no voice.
 */
async function rec(interaction: Interaction): Promise<Response> {
  const title = recTitle(interaction);
  const key = normalizeTitle(title);
  if (!key) return msg("Title required.");

  const by = caller(interaction);
  if (!by) return msg("Unknown user.");

  const added = await addRecommendation(env.DB, { title, title_key: key, ...by });
  const film = groupRecs(await getRecommendationsByKey(env.DB, key))[0]!;
  if (!added) return msg(`Already recommended **${film.title}**.`);

  // Recommenders run oldest first, so the caller is last; the rest already had it.
  const others = film.recommenders.slice(0, -1);
  return msg(
    others.length === 0
      ? `Added **${film.title}**.`
      : `Added **${film.title}**. Also recommended by ${listNames(others)}.`,
  );
}

/** /rec-film — one film off the recs, drawn at random. */
async function recFilm(): Promise<Response> {
  const films = groupRecs(await getRecommendations(env.DB));
  if (films.length === 0) return msg("No recommendations.");
  return components(buildRecCard(films[Math.floor(Math.random() * films.length)]!));
}

/** /unrec <title> — take your own rec of a film off the list. Only yours. */
async function unrec(interaction: Interaction): Promise<Response> {
  const title = recTitle(interaction);
  const key = normalizeTitle(title);
  if (!key) return msg("Title required.");

  const by = caller(interaction);
  if (!by) return msg("Unknown user.");

  const removed = await removeRecommendation(env.DB, key, by.discord_id);
  return msg(removed ? `Removed **${title}**.` : `**${title}** is not on your recommendations.`);
}

// --- plumbing ---------------------------------------------------------------

/** The title option, trimmed, with runs of whitespace collapsed. */
function recTitle(interaction: Interaction): string {
  return option(interaction, "title")?.trim().replace(/\s+/g, " ") ?? "";
}

/** Who ran the command: their id, the name they go by where they ran it, and their @handle. */
function caller(
  interaction: Interaction,
): (Recommender & Pick<Recommendation, "discord_id">) | null {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) return null;
  return {
    discord_id: user.id,
    discord_name: interaction.member?.nick || user.global_name || user.username,
    discord_username: user.username,
  };
}

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

/** Reply with Components V2 cards — the flag makes the message all-components. */
function components(...list: Container[]): Response {
  return json({ type: MESSAGE, data: { flags: IS_COMPONENTS_V2, components: list } });
}

/** Verify Discord's Ed25519 signature over timestamp + raw body. */
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

// The explicit <ArrayBuffer> matters — WebCrypto rejects the default
// Uint8Array<ArrayBufferLike>.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
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
  try {
    await fetch(
      `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (err) {
    // Can't reach the user through a reply we can't edit — just leave a trace.
    console.error("moobie-app: editReply failed:", err);
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
