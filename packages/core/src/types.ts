// Domain types. Row types use snake_case to match the D1 columns exactly, so
// SELECT * maps straight onto them — no transform layer.

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

/** One film in the group's catalog (aggregated from log_entries). */
export interface FilmCatalogEntry {
  film_key: string;
  film_title: string;
  logs: number; // how many logs the group has for it
  last_logged: string; // MAX(created_at) — recency tie-break for search
}

/** Aggregate stats for one user (a SELECT row — see getUserStats / getGroupStats). */
export interface UserStats {
  username: string;
  logs: number;
  films: number; // distinct films
  average: number | null; // ROUND(AVG(rating), 2); null if nothing rated
  liked: number;
  rewatches: number;
}

/** A row from the tracked_users table. */
export interface TrackedUser {
  username: string;
  discord_id: string | null;
  display_name: string | null; // display-only; username is the identity everywhere
  avatar_url: string | null;
  active: number; // 0 | 1
  added_at: string;
}
