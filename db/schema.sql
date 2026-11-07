-- moobie schema — 3 tables, film data denormalized into log_entries.
-- Every writer uses INSERT OR IGNORE on a UNIQUE key, so re-ingesting is a no-op
-- and the poll loop is idempotent. Do not remove the UNIQUE constraints.

-- People whose Letterboxd diaries we watch.
CREATE TABLE IF NOT EXISTS tracked_users (
  username        TEXT PRIMARY KEY,   -- Letterboxd username, lowercased — the identity everywhere
  discord_id      TEXT,               -- for @mentions; nullable
  display_name    TEXT,               -- friendly name for cards, display-only; nullable
  avatar_url      TEXT,               -- Letterboxd pfp; refreshed daily by the poll, nullable
  avatar_checked_at TEXT,             -- ISO timestamp of the last pfp check; null forces a refresh
  active          INTEGER NOT NULL DEFAULT 1,  -- 1/0 soft-disable
  added_at        TEXT NOT NULL       -- ISO timestamp
);

-- One row per diary entry. Append-only.
CREATE TABLE IF NOT EXISTS log_entries (
  guid          TEXT NOT NULL UNIQUE,  -- the dedup key (RSS <guid>)
  username      TEXT NOT NULL,         -- FK -> tracked_users.username
  film_key      TEXT NOT NULL,         -- normalized slug, groups entries across users
  film_title    TEXT NOT NULL,
  film_year     INTEGER,               -- nullable
  poster_url    TEXT,                  -- nullable
  rating        REAL,                  -- 0.5-5.0 half-steps; nullable (unrated logs)
  watched_date  TEXT,                  -- ISO date
  rewatch       INTEGER NOT NULL DEFAULT 0,  -- 1/0
  liked         INTEGER NOT NULL DEFAULT 0,  -- 1/0, the Letterboxd heart
  review        TEXT,                  -- nullable
  link          TEXT,                  -- canonical Letterboxd entry URL
  source        TEXT NOT NULL DEFAULT 'rss',  -- 'rss' for v1 (future: 'csv', 'api')
  created_at    TEXT NOT NULL          -- ISO timestamp (when we ingested it)
);

-- Look up all ratings of one film across users (analytics / compareFilm).
CREATE INDEX IF NOT EXISTS idx_log_entries_film_key ON log_entries(film_key);

-- Look up one user's logs, newest first (user pages).
CREATE INDEX IF NOT EXISTS idx_log_entries_username ON log_entries(username, watched_date DESC);

-- Films people want the pool to watch. Added from Discord only (/rec): the
-- interaction is signed, so the recommender is whoever Discord says ran it.
-- The typed title is resolved through TMDB search into a real film (title,
-- year, poster), and title_key is "tmdb:<id>" — so several people reccing one
-- film stack on it however they spelled it, and the same person twice is a
-- no-op. If TMDB can't be reached the rec is kept as typed, keyed on the title
-- collapsed to lowercase alphanumerics (same as /film search).
CREATE TABLE IF NOT EXISTS recommendations (
  id                INTEGER PRIMARY KEY,
  title             TEXT NOT NULL,     -- as this person typed it
  title_key         TEXT NOT NULL,     -- normalized title; groups everyone's recs of one film
  discord_id        TEXT NOT NULL,     -- who recommended it; the one identity that never changes
  discord_name      TEXT NOT NULL,     -- what they were called at the time: nick > display name > username
  discord_username  TEXT NOT NULL,     -- their @handle at the time; shown in brackets after the name
  tmdb_id           INTEGER,           -- TMDB film id when the title matched; null when TMDB couldn't be reached
  film_year         INTEGER,           -- from TMDB; nullable
  poster_url        TEXT,              -- TMDB poster; nullable
  created_at        TEXT NOT NULL,     -- ISO timestamp
  UNIQUE (title_key, discord_id)       -- one rec per film per person
);
