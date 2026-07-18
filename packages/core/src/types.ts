// Domain types for moobie.
//
// Row types use snake_case to match the D1 column names exactly. D1 returns rows
// keyed by column name, so `SELECT *` maps straight onto these types with no
// transform layer — one less place for bugs. SQL shape == TS shape, on purpose.

/** A diary entry parsed from Letterboxd RSS, ready to INSERT. */
export interface ParsedEntry {
  guid: string;
  username: string;
  film_key: string;
  film_title: string;
  film_year: number | null;
  poster_url: string | null;
  rating: number | null; // 0.5–5.0 in half-steps, or null for unrated logs
  watched_date: string | null; // ISO date (YYYY-MM-DD)
  rewatch: number; // 0 | 1
  liked: number; // 0 | 1, the Letterboxd heart
  review: string | null;
  link: string | null;
}

/** A full row from the log_entries table (a ParsedEntry plus ingestion metadata). */
export interface LogEntry extends ParsedEntry {
  source: string; // 'rss' | 'csv' | 'api'
  created_at: string; // ISO timestamp of when we ingested it
}

/** A row from the tracked_users table. */
export interface TrackedUser {
  username: string;
  discord_id: string | null;
  display_name: string | null; // display-only; username is the identity everywhere
  avatar_url: string | null;
  active: number; // 0 | 1
  last_seen_guid: string | null;
  added_at: string;
}
