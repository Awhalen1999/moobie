-- Recs resolve through TMDB now: the film's id, year, and poster live on the
-- row. Existing rows get NULLs. Run once against local and remote:
--   pnpm exec wrangler d1 execute moobie --local  --file=../db/migrations/003_rec_tmdb.sql
--   pnpm exec wrangler d1 execute moobie --remote --file=../db/migrations/003_rec_tmdb.sql
ALTER TABLE recommendations ADD COLUMN tmdb_id INTEGER;
ALTER TABLE recommendations ADD COLUMN film_year INTEGER;
ALTER TABLE recommendations ADD COLUMN poster_url TEXT;
