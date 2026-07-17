// Discord out (v1) — build an embed for a newly-logged film and POST it to the
// channel webhook. The builder is pure (easy to eyeball and test); the POST is a
// separate thin function. The poll loop calls announceEntry() once per new row.

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

/** Build the embed and POST it. Throws on a non-OK webhook response. */
export async function announceEntry(
  webhookUrl: string,
  entry: LogEntry,
  comparison: FilmComparison | null,
): Promise<void> {
  await postEmbed(webhookUrl, buildEntryEmbed(entry, comparison));
}

/** POST a single embed to a Discord channel webhook. */
export async function postEmbed(
  webhookUrl: string,
  embed: DiscordEmbed,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook ${res.status}: ${body}`);
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
