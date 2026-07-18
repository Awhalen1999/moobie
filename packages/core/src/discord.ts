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
  author?: { name: string; url?: string };
  title: string;
  url?: string;
  description?: string;
  thumbnail?: { url: string };
  fields?: EmbedField[];
  color: number;
  footer?: { text: string };
}

/** Render a 0.5–5.0 rating as stars, e.g. 3.5 -> "★★★½ (3.5)". Null -> "not rated". */
export function stars(rating: number | null): string {
  if (rating === null) return "not rated";
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return `${"★".repeat(full)}${half ? "½" : ""} (${rating})`;
}

/**
 * Build the embed announcing one new diary entry. `comparison` is the result of
 * compareFilm() over every entry for this film (may be null if unavailable);
 * when present, other users' ratings and any disagreement are shown.
 */
export function buildEntryEmbed(
  entry: LogEntry,
  comparison: FilmComparison | null,
): DiscordEmbed {
  const disagreement = comparison?.disagreement ?? false;

  const lines = [`**${stars(entry.rating)}**${entry.rewatch ? " · ↻ rewatch" : ""}`];
  if (entry.review) lines.push(`> ${truncate(entry.review, REVIEW_MAX)}`);

  const embed: DiscordEmbed = {
    author: {
      name: `${entry.username} logged a film`,
      url: `https://letterboxd.com/${entry.username}/`,
    },
    title: entry.film_year
      ? `${entry.film_title} (${entry.film_year})`
      : entry.film_title,
    description: lines.join("\n"),
    color: disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    footer: { text: `Watched ${entry.watched_date ?? "recently"}` },
  };
  if (entry.link) embed.url = entry.link;
  if (entry.poster_url) embed.thumbnail = { url: entry.poster_url };

  const fields = comparisonFields(entry, comparison);
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
): EmbedField[] {
  if (!comparison) return [];

  const others = comparison.ratings.filter((r) => r.username !== entry.username);
  const fields: EmbedField[] = [];

  if (others.length > 0) {
    fields.push({
      name: "Others",
      value: others.map((r) => `**${r.username}** — ${stars(r.rating)}`).join("\n"),
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
