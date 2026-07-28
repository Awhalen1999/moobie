// The one query module, shared by both Workers. Every function takes the D1
// binding as its first argument. Writes are INSERT OR IGNORE on a unique key,
// so re-ingesting the same entry is a no-op.

import type {
  FilmCatalogEntry,
  LogEntry,
  ParsedEntry,
  TrackedUser,
  UserStats,
} from "./types.ts";

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
 * Insert parsed entries, skipping guids we already have. Returns only the rows
 * actually inserted — exactly what to announce. One statement per row is
 * plenty at this scale.
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

/** Every log entry in the pool, newest watch first. Powers the web graph. */
export function getAllEntries(db: D1Database): Promise<LogEntry[]> {
  return db
    .prepare("SELECT * FROM log_entries ORDER BY watched_date DESC")
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

/**
 * One row per film the group has logged, with log count and recency. Small by
 * construction, so title matching happens in code (findFilm), not SQL.
 */
export function getFilmCatalog(db: D1Database): Promise<FilmCatalogEntry[]> {
  return db
    .prepare(
      `SELECT film_key, film_title, COUNT(*) AS logs, MAX(created_at) AS last_logged
       FROM log_entries GROUP BY film_key`,
    )
    .all<FilmCatalogEntry>()
    .then((r) => r.results);
}

const STATS_COLUMNS = `
  COUNT(*)                  AS logs,
  COUNT(DISTINCT film_key)  AS films,
  ROUND(AVG(rating), 2)     AS average,
  SUM(liked)                AS liked,
  SUM(rewatch)              AS rewatches`;

/** Aggregate stats for one user; null if they have no logs at all. */
export async function getUserStats(
  db: D1Database,
  username: string,
): Promise<UserStats | null> {
  const row = await db
    .prepare(`SELECT username, ${STATS_COLUMNS} FROM log_entries WHERE username = ?`)
    .bind(username)
    .first<UserStats>();
  return row && row.logs > 0 ? row : null;
}

/** Aggregate stats for everyone with logs, most logs first. */
export function getGroupStats(db: D1Database): Promise<UserStats[]> {
  return db
    .prepare(
      `SELECT username, ${STATS_COLUMNS} FROM log_entries
       GROUP BY username ORDER BY logs DESC`,
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
 * Add (or re-activate) a tracked user. Re-tracking with new details updates
 * them; COALESCE keeps the existing values when none are given.
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
