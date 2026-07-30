// Every card moobie posts, defined in one file. Pure builders — no delivery,
// no I/O. Sending lives with the poll Worker.

import type { FilmComparison, Superlative, UserRating } from "./analytics.ts";
import type { LogEntry, TrackedUser, UserStats } from "./types.ts";

// Letterboxd's palette: green normally, orange when raters disagree.
const COLOR_DEFAULT = 0x00e054;
const COLOR_DISAGREEMENT = 0xff8000;

const REVIEW_MAX = 280;

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

// --- Components V2 ---------------------------------------------------------
// The newer message system: a component tree instead of an embed, opted into
// per message with the IS_COMPONENTS_V2 flag. Cards migrate one at a time.

/** Message flag that switches a message to the Components V2 system. */
export const IS_COMPONENTS_V2 = 1 << 15;

interface TextDisplay {
  type: 10;
  content: string; // markdown
}

interface Thumbnail {
  type: 11;
  media: { url: string };
}

/** Text with a thumbnail (or button) docked on the right. */
interface Section {
  type: 9;
  components: TextDisplay[];
  accessory: Thumbnail;
}

interface Separator {
  type: 14;
  divider?: boolean;
}

/** Full-width image strip, 1-10 items; a lone image renders at natural size. */
interface MediaGallery {
  type: 12;
  items: { media: { url: string } }[];
}

/** The V2 equivalent of an embed: a box with an accent strip. */
export interface Container {
  type: 17;
  accent_color?: number;
  components: (TextDisplay | Section | Separator | MediaGallery)[];
}

const text = (content: string): TextDisplay => ({ type: 10, content });

/**
 * The announcement for one new log, and the /review card. `comparison` is
 * compareFilm() over every entry for the film; when present, everyone else's
 * ratings show too.
 */
export function buildEntryCard(
  entry: LogEntry,
  comparison: FilmComparison | null,
  context: EmbedContext = {},
): Container {
  const { displayNames = {} } = context;
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

  // The review's URL, shown the way the film card shows its link.
  const reviewLink = entry.link
    ? `\n-# [${entry.link.replace(/^https?:\/\//, "").replace(/\/$/, "")}](${entry.link})`
    : "";

  const header = text(
    `**[${name(entry.username)}](https://letterboxd.com/${entry.username}/) logged a film**\n` +
      `## [${filmTitle(entry)}](https://letterboxd.com/film/${entry.film_key}/)${reviewLink}\n${rating}` +
      (entry.review ? `\n> ${truncate(entry.review, REVIEW_MAX)}` : ""),
  );

  const others = comparison?.ratings.filter((r) => r.username !== entry.username) ?? [];

  return {
    type: 17,
    accent_color: disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    components: [
      header,
      ...(entry.poster_url
        ? [
            { type: 14 as const, divider: true },
            { type: 12 as const, items: [{ media: { url: entry.poster_url } }] },
          ]
        : []),
      ...(others.length > 0
        ? [
            { type: 14 as const, divider: true },
            text(`**Other reviews**\n${others.map((r) => ratingLine(r, name)).join("\n")}`),
          ]
        : []),
      { type: 14 as const, divider: true },
      text(`-# Logged ${friendlyDate(entry.watched_date) ?? "recently"}`),
    ],
  };
}


/**
 * Card for /film and /film-key — one film across the group: poster on top,
 * one line per rater, the name-vs-name gap line when raters disagree.
 */
export function buildFilmCard(
  comparison: FilmComparison,
  context: EmbedContext = {},
): Container {
  const { displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;

  const statLine = [
    `${comparison.ratings.length} logged`,
    comparison.average !== null ? `⭐ ${comparison.average} avg` : "",
    comparison.spread !== null ? `↔️ ${comparison.spread} gap` : "",
  ]
    .filter(Boolean)
    .join("\u2003");

  const gap = biggestGapLine(comparison, name);

  return {
    type: 17,
    accent_color: comparison.disagreement ? COLOR_DISAGREEMENT : COLOR_DEFAULT,
    components: [
      ...(comparison.poster_url
        ? [{ type: 12 as const, items: [{ media: { url: comparison.poster_url } }] }]
        : []),
      text(
        `## ${filmTitle(comparison)}\n` +
          `-# [letterboxd.com/film/${comparison.film_key}](https://letterboxd.com/film/${comparison.film_key}/)\n` +
          `-# ${statLine}`,
      ),
      { type: 14 as const, divider: true },
      text(comparison.ratings.map((r) => ratingLine(r, name)).join("\n")),
      ...(gap ? [{ type: 14 as const, divider: true }, text(gap)] : []),
    ],
  };
}

/**
 * Card for /stats, as Components V2. One person: their numbers beside their
 * avatar. The group: a leaderboard ranked by distinct films, biggest first.
 */
export function buildStatsCard(
  stats: UserStats[],
  context: EmbedContext = {},
): Container {
  const { avatarUrl = null, displayNames = {} } = context;
  const name = (username: string) => displayNames[username] ?? username;

  if (stats.length === 1) {
    const s = stats[0]!;
    const header = text(
      `## ${name(s.username)}\n-# [letterboxd.com/${s.username}](https://letterboxd.com/${s.username}/)`,
    );
    const body = text(
      [
        `🎬 ${s.films} film${s.films === 1 ? "" : "s"}`,
        avgStat(s.average),
        `❤️ ${s.liked} liked`,
        `🔁 ${s.rewatches} rewatch${s.rewatches === 1 ? "" : "es"}`,
      ].join("\n"),
    );
    return {
      type: 17,
      accent_color: COLOR_DEFAULT,
      components: [
        ...(avatarUrl ? [{ type: 12 as const, items: [{ media: { url: avatarUrl } }] }] : []),
        header,
        { type: 14 as const, divider: true },
        body,
      ],
    };
  }

  const ranked = [...stats].sort((a, b) => b.films - a.films);
  const logs = ranked.reduce((sum, s) => sum + s.logs, 0);
  const rows = ranked.map((s, i) => {
    const shown = i === 0 ? `**${name(s.username)}**` : name(s.username);
    return `${i + 1}. ${shown} 🎬 ${s.films} ${avgStat(s.average)} ❤️ ${s.liked}`;
  });

  return {
    type: 17,
    accent_color: COLOR_DEFAULT,
    components: [
      text(
        `## moobie stats\n-# ${ranked.length} member${ranked.length === 1 ? "" : "s"} · ` +
          `${logs} film${logs === 1 ? "" : "s"} logged`,
      ),
      { type: 14, divider: true },
      text(rows.join("\n")),
    ],
  };
}

/** "⭐ 3.4 avg" — or "⭐ no ratings" when nothing's rated. */
const avgStat = (average: number | null) =>
  average === null ? "⭐ no ratings" : `⭐ ${average} avg`;

/** Card for /best and /worst — every film at one end of a person's ratings. */
export function buildSuperlativeCard(
  kind: "best" | "worst",
  superlative: Superlative,
  context: EmbedContext = {},
): Container {
  const { displayNames = {} } = context;
  const { films } = superlative;
  const name = displayNames[films[0]!.username] ?? films[0]!.username;
  const plural = films.length === 1 ? "" : "s";
  return filmListCard(`${name}'s ${kind} film${plural}`, films, `${films.length} film${plural}`);
}

/** Card for /favorite — every film a person has liked. */
export function buildFavoritesCard(
  favorites: LogEntry[],
  context: EmbedContext = {},
): Container {
  const { displayNames = {} } = context;
  const name = displayNames[favorites[0]!.username] ?? favorites[0]!.username;
  return filmListCard(
    `${name}'s favorite films`,
    favorites,
    `${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`,
  );
}

// Films shown in a list card — posters and lines both — before "+ N more".
// 9 keeps the poster gallery a clean 3x3; 10 adds a full-width hero tile.
const LIST_MAX = 9;

/**
 * The shared film-list card (/best, /worst, /favorite): heading with the
 * person's link, a strip of the films' posters, then one rating-first line
 * per film, newest watch first. Pass at least one film — the routes guard
 * the empty case.
 */
function filmListCard(heading: string, films: LogEntry[], tally: string): Container {
  const first = films[0]!;
  const shown = films.slice(0, LIST_MAX);

  const posters = shown
    .filter((e) => e.poster_url)
    .map((e) => ({ media: { url: e.poster_url! } }));

  const lines = shown.map((e) => `${stars(e.rating)} - **${filmTitle(e)}**`);
  const more = films.length - LIST_MAX;
  if (more > 0) lines.push(`-# + ${more} more`);

  return {
    type: 17,
    accent_color: COLOR_DEFAULT,
    components: [
      text(
        `## ${heading}\n-# [letterboxd.com/${first.username}](https://letterboxd.com/${first.username}/) · ${tally}`,
      ),
      { type: 14 as const, divider: true },
      ...(posters.length > 0
        ? [{ type: 12 as const, items: posters }, { type: 14 as const, divider: true }]
        : []),
      text(lines.join("\n")),
    ],
  };
}

// --- helpers -------------------------------------------------------------

/** One rater's line on a card: name, stars, and their heart if they liked it. */
function ratingLine(r: UserRating, name: (username: string) => string): string {
  return `**${name(r.username)}** - ${stars(r.rating)}${r.liked ? "\u2003❤️" : ""}`;
}

/** The two extreme raters, name vs name — shown when the gap threshold trips. */
function biggestGapLine(
  comparison: FilmComparison,
  name: (username: string) => string,
): string | null {
  if (!comparison.disagreement || comparison.spread === null) return null;

  const rated = comparison.ratings.filter((r) => r.rating !== null);
  if (rated.length < 2) return null;
  const hi = rated.reduce((a, b) => (b.rating! > a.rating! ? b : a));
  const lo = rated.reduce((a, b) => (b.rating! < a.rating! ? b : a));

  return (
    `⚠️ **${name(hi.username)}** - ${stars(hi.rating)} vs ` +
    `**${name(lo.username)}** - ${stars(lo.rating)}`
  );
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
