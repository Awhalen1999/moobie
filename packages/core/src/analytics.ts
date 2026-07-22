// Analytics — pure functions over log entries (invariant #4). No DB, no network,
// no framework. The caller loads rows (e.g. getEntriesByFilmKey) and passes them
// in; the poll loop, the Discord commands, and the web API all share these exact
// functions. Keep it that way: never load data or touch a route in here.

import type { FilmCatalogEntry, LogEntry } from "./types.ts";

/** A single user's standing opinion on one film. */
export interface UserRating {
  username: string;
  rating: number | null; // null = logged but not rated
  watched_date: string | null;
  rewatch: number;
  liked: number; // 0 | 1, the Letterboxd heart
}

/** The comparison of one film across everyone who has logged it. */
export interface FilmComparison {
  film_key: string;
  film_title: string;
  film_year: number | null;
  poster_url: string | null;
  ratings: UserRating[]; // one per user, most-recent watch first
  average: number | null; // mean of the users who rated it
  spread: number | null; // highest minus lowest rating
  disagreement: boolean; // spread >= threshold, with >= 2 raters
}

/** Ratings this far apart (in stars) count as a disagreement worth flagging. */
export const DISAGREEMENT_THRESHOLD = 3;

/**
 * Compare one film across all its log entries. Pass every entry for a single
 * film_key (rewatches and multiple users included); each user is collapsed to
 * their most recent watch. Returns per-user ratings plus average, spread, and a
 * disagreement flag. Returns null if given no entries.
 */
export function compareFilm(
  entries: LogEntry[],
  threshold = DISAGREEMENT_THRESHOLD,
): FilmComparison | null {
  if (entries.length === 0) return null;

  const ratings = latestPerUser(entries);
  const values = ratings
    .map((r) => r.rating)
    .filter((r): r is number => r !== null);

  const average = values.length > 0 ? mean(values) : null;
  const spread =
    values.length >= 2 ? Math.max(...values) - Math.min(...values) : null;

  // Represent the film with the entry that has the most complete metadata.
  const face = pickFilmFace(entries);

  return {
    film_key: face.film_key,
    film_title: face.film_title,
    film_year: face.film_year,
    poster_url: face.poster_url,
    ratings,
    average,
    spread,
    disagreement: spread !== null && spread >= threshold,
  };
}

/**
 * Find the film a human meant. Case, punctuation, and spacing insensitive:
 * query and titles both collapse to lowercase alphanumerics, so "i, robot",
 * "I ROBOT", and "irobot" all hit "I, Robot". Exact normalized match beats
 * prefix beats substring; ties go to the most-logged film, then the most
 * recently ingested. Returns null when nothing matches — the caller points
 * people at /film-key, which is exact and always works.
 */
export function findFilm(
  catalog: FilmCatalogEntry[],
  query: string,
): FilmCatalogEntry | null {
  const q = normalizeTitle(query);
  if (!q) return null;

  let best: FilmCatalogEntry | null = null;
  let bestRank = 0;
  for (const film of catalog) {
    const title = normalizeTitle(film.film_title);
    const rank = title === q ? 3 : title.startsWith(q) ? 2 : title.includes(q) ? 1 : 0;
    if (rank === 0) continue;
    if (rank > bestRank || (rank === bestRank && best !== null && beats(film, best))) {
      best = film;
      bestRank = rank;
    }
  }
  return best;
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Search tie-break: more logs wins, then most recently ingested. */
function beats(a: FilmCatalogEntry, b: FilmCatalogEntry): boolean {
  if (a.logs !== b.logs) return a.logs > b.logs;
  return a.last_logged > b.last_logged;
}

/** One end of a user's ratings: their best (or worst) films (see bestFilms). */
export interface Superlative {
  rating: number; // the extreme rating, in stars
  films: LogEntry[]; // every film at that rating, most recently watched first
}

/** The films a user rated highest. Pass their full history. */
export function bestFilms(entries: LogEntry[]): Superlative | null {
  return extreme(entries, (rating, best) => rating > best);
}

/** The films a user rated lowest. Pass their full history. */
export function worstFilms(entries: LogEntry[]): Superlative | null {
  return extreme(entries, (rating, worst) => rating < worst);
}

/**
 * The films at one end of a user's ratings. Each film counts once, at its most
 * recent *rated* log — so an unrated rewatch never erases a rating. Every film
 * tied at the extreme rating is included. Returns null when nothing is rated.
 */
function extreme(
  entries: LogEntry[],
  wins: (rating: number, current: number) => boolean,
): Superlative | null {
  const rated = [...latestPerFilm(entries.filter((e) => e.rating !== null)).values()];
  if (rated.length === 0) return null;

  let target = rated[0]!.rating!;
  for (const e of rated) {
    if (wins(e.rating!, target)) target = e.rating!;
  }

  const films = rated
    .filter((e) => e.rating === target)
    .sort((a, b) => compareRecency(b, a));
  return { rating: target, films };
}

/**
 * The films a user has liked (the ❤️), each at its most recent liked log,
 * most recently watched first. Pass their full history.
 */
export function favoriteFilms(entries: LogEntry[]): LogEntry[] {
  return [...latestPerFilm(entries.filter((e) => e.liked === 1)).values()].sort(
    (a, b) => compareRecency(b, a),
  );
}

// --- helpers -------------------------------------------------------------

/** Collapse a history to one row per film (the most recent log of each). */
function latestPerFilm(entries: LogEntry[]): Map<string, LogEntry> {
  const byFilm = new Map<string, LogEntry>();
  for (const e of entries) {
    const current = byFilm.get(e.film_key);
    if (!current || isNewer(e, current)) {
      byFilm.set(e.film_key, e);
    }
  }
  return byFilm;
}

/** Collapse to one row per user (their most recent watch), newest user first. */
function latestPerUser(entries: LogEntry[]): UserRating[] {
  const byUser = new Map<string, LogEntry>();
  for (const e of entries) {
    const current = byUser.get(e.username);
    if (!current || isNewer(e, current)) {
      byUser.set(e.username, e);
    }
  }
  return [...byUser.values()]
    .sort((a, b) => compareRecency(b, a))
    .map((e) => ({
      username: e.username,
      rating: e.rating,
      watched_date: e.watched_date,
      rewatch: e.rewatch,
      liked: e.liked,
    }));
}

/** True if `a` is a more recent watch than `b`. */
function isNewer(a: LogEntry, b: LogEntry): boolean {
  return compareRecency(a, b) > 0;
}

/**
 * Order two entries by watch recency, oldest first; guid breaks ties
 * deterministically. The one comparator for log recency — sort ascending with
 * it directly, or flip the arguments for newest-first.
 */
export function compareRecency(a: LogEntry, b: LogEntry): number {
  const da = a.watched_date ?? "";
  const db = b.watched_date ?? "";
  if (da !== db) return da < db ? -1 : 1;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

/** Prefer an entry that actually has a poster / year to represent the film. */
function pickFilmFace(entries: LogEntry[]): LogEntry {
  return entries.find((e) => e.poster_url && e.film_year !== null) ?? entries[0]!;
}

function mean(values: number[]): number {
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 100) / 100;
}
