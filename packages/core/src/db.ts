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
        rating, watched_date, rewatch, review, link, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** Add (or re-activate) a tracked user. Idempotent on username. */
export async function addTrackedUser(
  db: D1Database,
  username: string,
  discordId: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tracked_users (username, discord_id, active, added_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(username) DO UPDATE SET active = 1`,
    )
    .bind(username, discordId, new Date().toISOString())
    .run();
}
