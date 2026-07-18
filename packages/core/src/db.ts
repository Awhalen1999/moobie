// D1 query helpers — the single source of DB access, imported by both the poll
// Worker and the Astro app (invariant #7: no duplication).
//
// Every function takes the D1 binding as its first argument. The db module never
// reaches into global env, so it stays pure and portable: the Worker passes
// `env.DB` from its scheduled() handler, an endpoint passes `env.DB` from the
// `cloudflare:workers` import. Same functions, either caller.
//
// Invariant #1: every write is INSERT OR IGNORE on a UNIQUE key, so re-ingesting
// the same entry is a no-op and every writer is idempotent.

import type { LogEntry, ParsedEntry, TrackedUser } from "./types.ts";

/** All users whose diaries we actively poll. */
export function getActiveUsers(db: D1Database): Promise<TrackedUser[]> {
  return db
    .prepare("SELECT * FROM tracked_users WHERE active = 1 ORDER BY username")
    .all<TrackedUser>()
    .then((r) => r.results);
}

/** Every tracked user, active or not — for display-name lookups over history. */
export function getAllTrackedUsers(db: D1Database): Promise<TrackedUser[]> {
  return db
    .prepare("SELECT * FROM tracked_users ORDER BY username")
    .all<TrackedUser>()
    .then((r) => r.results);
}

/** How many entries we already hold for a user. Used to detect a first ingest. */
export async function countEntriesForUser(
  db: D1Database,
  username: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM log_entries WHERE username = ?")
    .bind(username)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Insert parsed entries, skipping any whose guid we already have.
 * Returns only the rows that were actually inserted (the new ones), so callers
 * know exactly what to announce to Discord.
 *
 * Entries are inserted one at a time and kept when meta.changes === 1. At a
 * friend-group's volume (~50 rows per poll) this is plenty fast and stays
 * obvious — no batch-result bookkeeping to get wrong.
 */
export async function insertEntries(
  db: D1Database,
  entries: ParsedEntry[],
  source = "rss",
): Promise<LogEntry[]> {
  const created_at = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO log_entries
       (guid, username, film_key, film_title, film_year, poster_url,
        rating, watched_date, rewatch, liked, review, link, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const inserted: LogEntry[] = [];
  for (const e of entries) {
    const result = await stmt
      .bind(
        e.guid,
        e.username,
        e.film_key,
        e.film_title,
        e.film_year,
        e.poster_url,
        e.rating,
        e.watched_date,
        e.rewatch,
        e.liked,
        e.review,
        e.link,
        source,
        created_at,
      )
      .run();
    if (result.meta.changes === 1) {
      inserted.push({ ...e, source, created_at });
    }
  }
  return inserted;
}

/** All entries for one film (across all users), newest watch first. */
export function getEntriesByFilmKey(
  db: D1Database,
  filmKey: string,
): Promise<LogEntry[]> {
  return db
    .prepare(
      "SELECT * FROM log_entries WHERE film_key = ? ORDER BY watched_date DESC",
    )
    .bind(filmKey)
    .all<LogEntry>()
    .then((r) => r.results);
}

/** One user's whole history, newest watch first. */
export function getEntriesForUser(
  db: D1Database,
  username: string,
): Promise<LogEntry[]> {
  return db
    .prepare(
      "SELECT * FROM log_entries WHERE username = ? ORDER BY watched_date DESC",
    )
    .bind(username)
    .all<LogEntry>()
    .then((r) => r.results);
}

export interface FilmSearchHit {
  film_key: string;
  film_title: string;
  entries: number;
}

/** Films whose title contains the query, most-logged first. */
export function searchFilms(
  db: D1Database,
  query: string,
  limit = 3,
): Promise<FilmSearchHit[]> {
  return db
    .prepare(
      `SELECT film_key, film_title, COUNT(*) AS entries
       FROM log_entries
       WHERE film_title LIKE ?
       GROUP BY film_key
       ORDER BY entries DESC, film_title
       LIMIT ?`,
    )
    .bind(`%${query}%`, limit)
    .all<FilmSearchHit>()
    .then((r) => r.results);
}

export interface UserStats {
  username: string;
  entries: number;
  films: number; // distinct films
  average: number | null; // null if nothing rated
  liked: number;
  rewatches: number;
}

const STATS_COLUMNS = `
  COUNT(*)                  AS entries,
  COUNT(DISTINCT film_key)  AS films,
  ROUND(AVG(rating), 2)     AS average,
  SUM(liked)                AS liked,
  SUM(rewatch)              AS rewatches`;

/** Aggregate stats for one user; null if they have no entries at all. */
export async function getUserStats(
  db: D1Database,
  username: string,
): Promise<UserStats | null> {
  const row = await db
    .prepare(`SELECT username, ${STATS_COLUMNS} FROM log_entries WHERE username = ?`)
    .bind(username)
    .first<UserStats>();
  return row && row.entries > 0 ? row : null;
}

/** Aggregate stats for everyone with entries, most logs first. */
export function getGroupStats(db: D1Database): Promise<UserStats[]> {
  return db
    .prepare(
      `SELECT username, ${STATS_COLUMNS} FROM log_entries
       GROUP BY username ORDER BY entries DESC`,
    )
    .all<UserStats>()
    .then((r) => r.results);
}

export interface TrackedUserDetails {
  discordId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

/**
 * Add (or re-activate) a tracked user. Idempotent on username; re-tracking with
 * new details updates them (COALESCE keeps existing values when none given).
 */
export async function addTrackedUser(
  db: D1Database,
  username: string,
  details: TrackedUserDetails = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tracked_users (username, discord_id, display_name, avatar_url, active, added_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(username) DO UPDATE SET
         active = 1,
         discord_id = COALESCE(excluded.discord_id, discord_id),
         display_name = COALESCE(excluded.display_name, display_name),
         avatar_url = COALESCE(excluded.avatar_url, avatar_url)`,
    )
    .bind(
      username,
      details.discordId ?? null,
      details.displayName ?? null,
      details.avatarUrl ?? null,
      new Date().toISOString(),
    )
    .run();
}

/** Soft-disable a tracked user. Returns false if the username isn't tracked. */
export async function deactivateTrackedUser(
  db: D1Database,
  username: string,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE tracked_users SET active = 0 WHERE username = ? AND active = 1")
    .bind(username)
    .run();
  return result.meta.changes > 0;
}

/** Store a user's Letterboxd avatar URL (fetched lazily by the poll). */
export async function setUserAvatar(
  db: D1Database,
  username: string,
  avatarUrl: string,
): Promise<void> {
  await db
    .prepare("UPDATE tracked_users SET avatar_url = ? WHERE username = ?")
    .bind(avatarUrl, username)
    .run();
}
