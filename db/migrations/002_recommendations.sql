-- Adds the recommendations table (/rec, /rec-film, the site's recs page).
-- Run once against local and remote:
--   pnpm exec wrangler d1 execute moobie --local  --file=../db/migrations/002_recommendations.sql
--   pnpm exec wrangler d1 execute moobie --remote --file=../db/migrations/002_recommendations.sql
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
