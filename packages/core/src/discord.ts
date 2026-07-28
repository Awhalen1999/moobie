// Every card moobie posts, defined in one file. Pure builders — no delivery,
// no I/O. Sending lives with the poll Worker.

import type { FilmComparison, Superlative, UserRating } from "./analytics.ts";
import type { LogEntry, TrackedUser, UserStats } from "./types.ts";

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
  title?: string;
  url?: string;
  description?: string;
  thumbnail?: { url: string }; // small, top-right
  image?: { url: string }; // large, full-width
  fields?: EmbedField[];
  color: number;
  footer?: { text: string };
}

/**
 * Render a rating as emoji stars, e.g. 3.5 -> "⭐ ⭐ ⭐ ½ (3.5)".
 * Null -> "not rated".
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

/** username -> display name for card rendering; falls back to the username. */
export function displayNameMap(users: TrackedUser[]): Record<string, string> {
  return Object.fromEntries(users.map((u) => [u.username, u.display_name ?? u.username]));
}

/** "Title (Year)" — or just the title when the year is unknown. */
export function filmTitle(film: { film_title: string; film_year: number | null }): string {
  return film.film_year ? `${film.film_title} (${film.film_year})` : film.film_title;
}

/**
 * The announcement for one new log. `comparison` is compareFilm() over every
 * entry for the film; when present, everyone else's ratings show too.
 */
export function buildEntryEmbed(
  entry: LogEntry,
  comparison: FilmComparison | null,
  context: EmbedContext = {},
): DiscordEmbed {
  const { avatarUrl = null, displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;
  const disagreement = comparison?.disagreement ?? false;

  // Em-spaces keep air between the rating, heart, and rewatch marker —
  // Discord collapses consecutive normal spaces.
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
    title: filmTitle(entry),
    description: entry.review
      ? `${rating}\n> ${truncate(entry.review, REVIEW_MAX)}`
      : rating,
    color: disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    footer: { text: `Logged ${friendlyDate(entry.watched_date) ?? "recently"}` },
  };
  if (entry.link) embed.url = entry.link;
  if (entry.poster_url) embed.image = { url: entry.poster_url };

  const fields = comparisonFields(entry, comparison, name);
  if (fields.length > 0) embed.fields = fields;

  return embed;
}

/**
 * Card for /film and /film-key — one film across the group. One line per
 * rater, avg in the footer, the name-vs-name gap field when raters disagree.
 */
export function buildFilmEmbed(
  comparison: FilmComparison,
  context: EmbedContext = {},
): DiscordEmbed {
  const { displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;

  const summary = [
    `${comparison.ratings.length} logged`,
    comparison.average !== null ? `⭐ avg ${comparison.average}` : "",
  ]
    .filter(Boolean)
    .join("\u2003");

  const embed: DiscordEmbed = {
    title: filmTitle(comparison),
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

/**
 * Card for /stats — one line of numbers per user. A single user gets their
 * name in the title; the group card is titled for the pool.
 */
export function buildStatsEmbed(
  stats: UserStats[],
  context: EmbedContext = {},
): DiscordEmbed {
  const { displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;

  const single = stats.length === 1 ? stats[0]! : null;
  return {
    title: single ? `${name(single.username)} - stats` : "moobie stats",
    description: single
      ? statsLine(single)
      : stats.map((s) => `**${name(s.username)}**\n${statsLine(s)}`).join("\n\n"),
    color: COLOR_DEFAULT,
  };
}

/** Card for /best and /worst — every film at one end of a person's ratings. */
export function buildSuperlativeEmbed(
  kind: "best" | "worst",
  superlative: Superlative,
  context: EmbedContext = {},
): DiscordEmbed {
  const { avatarUrl = null, displayNames = {} } = context;
  const { films } = superlative;
  const name = displayNames[films[0]!.username] ?? films[0]!.username;
  const plural = films.length === 1 ? "" : "s";
  return filmListEmbed(
    `${name}'s ${kind} film${plural}`,
    films,
    `${films.length} film${plural}`,
    avatarUrl,
  );
}

/** Card for /favorite — every film a person has liked. */
export function buildFavoritesEmbed(
  favorites: LogEntry[],
  context: EmbedContext = {},
): DiscordEmbed {
  const { avatarUrl = null, displayNames = {} } = context;
  const name = displayNames[favorites[0]!.username] ?? favorites[0]!.username;
  return filmListEmbed(
    `${name}'s favorite films`,
    favorites,
    `${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`,
    avatarUrl,
  );
}

/** Films shown by name in a list card before collapsing to "+ N more". */
const LIST_MAX = 25;

/**
 * The shared film-list card (/best, /worst, /favorite): the person as the
 * author line, one line per film, newest watch first, the newest film's poster
 * below. Pass at least one film — the routes guard the empty case.
 */
function filmListEmbed(
  heading: string,
  films: LogEntry[],
  footer: string,
  avatarUrl: string | null,
): DiscordEmbed {
  const first = films[0]!;

  const lines = films.slice(0, LIST_MAX).map((e) => {
    const logged = friendlyDate(e.watched_date);
    return `**${filmTitle(e)}** - ${stars(e.rating)}${logged ? ` - Logged ${logged}` : ""}`;
  });
  const more = films.length - LIST_MAX;
  if (more > 0) lines.push(`+ ${more} more`);

  const embed: DiscordEmbed = {
    author: {
      name: heading,
      url: `https://letterboxd.com/${first.username}/`,
      ...(avatarUrl ? { icon_url: avatarUrl } : {}),
    },
    description: lines.join("\n"),
    color: COLOR_DEFAULT,
    footer: { text: footer },
  };
  if (first.poster_url) embed.image = { url: first.poster_url };
  return embed;
}

// --- helpers -------------------------------------------------------------

/** The "Other reviews" field — how everyone else rated this film. */
function comparisonFields(
  entry: LogEntry,
  comparison: FilmComparison | null,
  name: (username: string) => string,
): EmbedField[] {
  if (!comparison) return [];

  const others = comparison.ratings.filter((r) => r.username !== entry.username);
  if (others.length === 0) return [];

  return [
    {
      name: "Other reviews",
      value: others.map((r) => ratingLine(r, name)).join("\n"),
    },
  ];
}

/** One rater's line on a card: name, stars, and their heart if they liked it. */
function ratingLine(r: UserRating, name: (username: string) => string): string {
  return `**${name(r.username)}** - ${stars(r.rating)}${r.liked ? "\u2003❤️" : ""}`;
}

function statsLine(s: UserStats): string {
  const avg = s.average !== null ? `⭐ avg ${s.average}` : "⭐ nothing rated";
  return [`${s.films} films`, avg, `❤️ ${s.liked}`, `🔁 ${s.rewatches}`].join("\u2003");
}

/** The two extreme raters, name vs name — shown when the gap threshold trips. */
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
      `**${name(hi.username)}** - ${stars(hi.rating)} vs ` +
      `**${name(lo.username)}** - ${stars(lo.rating)}`,
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
