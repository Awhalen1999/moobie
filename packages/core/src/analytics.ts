// Analytics — pure functions over log entries (invariant #4). No DB, no network,
// no framework. The caller loads rows (e.g. getEntriesByFilmKey) and passes them
// in; the poll loop, the Discord commands, and the web API all share these exact
// functions. Keep it that way: never load data or touch a route in here.

import type { LogEntry } from "./types.ts";

/** A single user's standing opinion on one film. */
export interface UserRating {
  username: string;
  rating: number | null; // null = logged but not rated
  watched_date: string | null;
  rewatch: number;
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
export const DISAGREEMENT_THRESHOLD = 1.5;

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

// --- helpers -------------------------------------------------------------

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
    }));
}

/** True if `a` is a more recent watch than `b`. */
function isNewer(a: LogEntry, b: LogEntry): boolean {
  return compareRecency(a, b) > 0;
}

/** Order two entries by watch recency; guid breaks ties deterministically. */
function compareRecency(a: LogEntry, b: LogEntry): number {
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
