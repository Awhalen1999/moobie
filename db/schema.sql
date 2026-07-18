-- moobie schema — 2 tables, film data denormalized into log_entries.
-- Every writer uses INSERT OR IGNORE on a UNIQUE key, so re-ingesting is a no-op
-- and the poll loop is idempotent. Do not remove the UNIQUE constraints.

-- People whose Letterboxd diaries we watch.
CREATE TABLE IF NOT EXISTS tracked_users (
  username        TEXT PRIMARY KEY,   -- Letterboxd username, lowercased
  discord_id      TEXT,               -- for @mentions; nullable
  avatar_url      TEXT,               -- Letterboxd pfp; fetched lazily, nullable
  active          INTEGER NOT NULL DEFAULT 1,  -- 1/0 soft-disable
  last_seen_guid  TEXT,               -- optional optimization; dedup is by guid regardless
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

-- Look up one user's entries, newest first (diary views).
CREATE INDEX IF NOT EXISTS idx_log_entries_username ON log_entries(username, watched_date DESC);
