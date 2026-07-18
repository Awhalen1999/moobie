// Discord out — pure embed builders (easy to eyeball and test) plus one thin
// delivery function that posts as the bot (invariant #6: bot token, never
// channel webhooks). The poll Worker announces new rows; the /interactions
// route replies with the same embed shapes.

import type { FilmComparison, UserRating } from "./analytics.ts";
import type { LogEntry } from "./types.ts";

// Letterboxd's palette: green normally, orange when raters disagree.
const COLOR_DEFAULT = 0x00e054;
const COLOR_DISAGREEMENT = 0xff8000;

const REVIEW_MAX = 280;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  author?: { name: string; url?: string; icon_url?: string };
  title: string;
  url?: string;
  description?: string;
  thumbnail?: { url: string }; // small, top-right
  image?: { url: string }; // large, full-width
  fields?: EmbedField[];
  color: number;
  footer?: { text: string };
}

/**
 * Render a 0.5–5.0 rating as emoji stars, e.g. 3.5 -> "⭐ ⭐ ⭐ ½ (3.5)".
 * Null -> "not rated". Discord can't letter-space or color text, so the gold
 * comes from the emoji and the tracking is baked into the string.
 */
export function stars(rating: number | null): string {
  if (rating === null) return "not rated";
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const glyphs = [...Array<string>(full).fill("⭐"), ...(half ? ["½"] : [])];
  return `${glyphs.join(" ")} (${rating})`;
}

export interface EmbedContext {
  /** The logger's Letterboxd pfp, shown beside their name. */
  avatarUrl?: string | null;
  /** username -> display_name for everyone tracked; falls back to username. */
  displayNames?: Record<string, string>;
  /**
   * Review truncation length. Announcements keep the default (280) so the
   * channel stays scannable; deliberate lookups like /review raise it.
   */
  reviewMax?: number;
  /** Include the "Biggest gap" field. Announcements do; /review doesn't. */
  includeGap?: boolean;
}

/**
 * Build the embed announcing one new diary entry. `comparison` is the result of
 * compareFilm() over every entry for this film (may be null if unavailable);
 * when present, other users' ratings and any disagreement are shown.
 */
export function buildEntryEmbed(
  entry: LogEntry,
  comparison: FilmComparison | null,
  context: EmbedContext = {},
): DiscordEmbed {
  const {
    avatarUrl = null,
    displayNames = {},
    reviewMax = REVIEW_MAX,
    includeGap = true,
  } = context;
  const name = (username: string) => displayNames[username] ?? username;
  const disagreement = comparison?.disagreement ?? false;

  // Em-spaces (U+2003) keep clear air between the rating, the heart, and the
  // rewatch marker without relying on consecutive-space rendering.
  const rating = [
    `**${stars(entry.rating)}**`,
    entry.liked ? "❤️" : "",
    entry.rewatch ? "🔁" : "",
  ]
    .filter(Boolean)
    .join("\u2003");

  const embed: DiscordEmbed = {
    author: {
      name: `${name(entry.username)} logged a film`,
      url: `https://letterboxd.com/${entry.username}/`,
      ...(avatarUrl ? { icon_url: avatarUrl } : {}),
    },
    title: entry.film_year
      ? `${entry.film_title} (${entry.film_year})`
      : entry.film_title,
    description: entry.review
      ? `${rating}\n> ${truncate(entry.review, reviewMax)}`
      : rating,
    color: disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    footer: { text: `Logged ${friendlyDate(entry.watched_date) ?? "recently"}` },
  };
  if (entry.link) embed.url = entry.link;
  if (entry.poster_url) embed.image = { url: entry.poster_url };

  const fields = comparisonFields(entry, comparison, name, includeGap);
  if (fields.length > 0) embed.fields = fields;

  return embed;
}

/**
 * Card for /film and /film-key — one film across the whole group. Small poster
 * (it's a lookup card, not an announcement), one line per rater, avg in the
 * footer, and the name-vs-name gap field when raters disagree.
 */
export function buildFilmEmbed(
  comparison: FilmComparison,
  context: EmbedContext = {},
): DiscordEmbed {
  const { displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;

  const summary = [
    `${comparison.ratings.length} logged`,
    comparison.average !== null ? `avg ${comparison.average}` : "",
  ]
    .filter(Boolean)
    .join("\u2003");

  const embed: DiscordEmbed = {
    title: comparison.film_year
      ? `${comparison.film_title} (${comparison.film_year})`
      : comparison.film_title,
    url: `https://letterboxd.com/film/${comparison.film_key}/`,
    description: comparison.ratings.map((r) => ratingLine(r, name)).join("\n"),
    color: comparison.disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    footer: { text: summary },
  };
  if (comparison.poster_url) embed.thumbnail = { url: comparison.poster_url };

  const gap = biggestGapField(comparison, name);
  if (gap) embed.fields = [gap];
  return embed;
}

const API_BASE = "https://discord.com/api/v10";

/** POST one embed to a channel as the bot. Throws on a non-OK response. */
export async function sendChannelMessage(
  botToken: string,
  channelId: string,
  embed: DiscordEmbed,
): Promise<void> {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord ${res.status} posting to channel ${channelId}: ${body}`);
  }
}

// --- helpers -------------------------------------------------------------

/** Fields listing how everyone else rated this film, and a disagreement note. */
function comparisonFields(
  entry: LogEntry,
  comparison: FilmComparison | null,
  name: (username: string) => string,
  includeGap: boolean,
): EmbedField[] {
  if (!comparison) return [];

  const others = comparison.ratings.filter((r) => r.username !== entry.username);
  const fields: EmbedField[] = [];

  if (others.length > 0) {
    fields.push({
      name: "Other reviews",
      value: others.map((r) => ratingLine(r, name)).join("\n"),
    });
  }

  if (includeGap) {
    const gap = biggestGapField(comparison, name);
    if (gap) fields.push(gap);
  }

  return fields;
}

/** One rater's line on a card: name, stars, and their heart if they liked it. */
function ratingLine(r: UserRating, name: (username: string) => string): string {
  return `**${name(r.username)}** - ${stars(r.rating)}${r.liked ? " ❤️" : ""}`;
}

/**
 * The two extreme raters, name vs name — shown only when the disagreement
 * threshold trips, on both the announcement and the /film card.
 */
function biggestGapField(
  comparison: FilmComparison | null,
  name: (username: string) => string,
): EmbedField | null {
  if (!comparison?.disagreement || comparison.spread === null) return null;

  const rated = comparison.ratings.filter((r) => r.rating !== null);
  if (rated.length < 2) return null;
  const hi = rated.reduce((a, b) => (b.rating! > a.rating! ? b : a));
  const lo = rated.reduce((a, b) => (b.rating! < a.rating! ? b : a));

  return {
    name: "⚠️ Biggest gap",
    value:
      `**${name(hi.username)}** ${stars(hi.rating)} vs ` +
      `**${name(lo.username)}** ${stars(lo.rating)}`,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-05-25" -> "May 25, 2026". Null (or unexpected shapes) -> null. */
function friendlyDate(isoDate: string | null): string | null {
  const m = isoDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}
