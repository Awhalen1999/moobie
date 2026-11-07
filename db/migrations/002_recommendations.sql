-- Adds the recommendations table (/rec, /rec-film, the site's recs page).
-- Run once against local and remote:
--   pnpm exec wrangler d1 execute moobie --local  --file=../db/migrations/002_recommendations.sql
--   pnpm exec wrangler d1 execute moobie --remote --file=../db/migrations/002_recommendations.sql
CREATE TABLE IF NOT EXISTS recommendations (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,         -- as this person typed it
  title_key     TEXT NOT NULL,         -- normalized title; groups everyone's recs of one film
  discord_id    TEXT NOT NULL,         -- who recommended it; the stable identity
  discord_name  TEXT NOT NULL,         -- their name at the time: nick > display name > username
  created_at    TEXT NOT NULL,         -- ISO timestamp
  UNIQUE (title_key, discord_id)       -- one rec per film per person
);
