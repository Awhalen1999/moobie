// Discord out — pure embed builders (easy to eyeball and test) plus one thin
// delivery function that posts as the bot (invariant #6: bot token, never
// channel webhooks). The poll Worker announces new rows; the /interactions
// route replies with the same embed shapes.

import type { FilmComparison } from "./analytics.ts";
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
  const { avatarUrl = null, displayNames = {} } = context;
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
      ? `${rating}\n> ${truncate(entry.review, REVIEW_MAX)}`
      : rating,
    color: disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    footer: { text: `Watched ${friendlyDate(entry.watched_date) ?? "recently"}` },
  };
  if (entry.link) embed.url = entry.link;
  if (entry.poster_url) embed.image = { url: entry.poster_url };

  const fields = comparisonFields(entry, comparison, name);
  if (fields.length > 0) embed.fields = fields;

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
): EmbedField[] {
  if (!comparison) return [];

  const others = comparison.ratings.filter((r) => r.username !== entry.username);
  const fields: EmbedField[] = [];

  if (others.length > 0) {
    fields.push({
      name: "Others",
      value: others.map((r) => `**${name(r.username)}** — ${stars(r.rating)}`).join("\n"),
    });
  }

  if (comparison.disagreement && comparison.spread !== null) {
    fields.push({
      name: "⚠️ Disagreement",
      value: `${comparison.spread} stars apart (avg ${comparison.average})`,
    });
  }

  return fields;
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
