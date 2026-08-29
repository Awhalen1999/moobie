-- Adds the avatar freshness stamp. Existing rows get NULL, which the poll
-- treats as "never checked" — every avatar refreshes on the first tick after
-- deploy. Run once against local and remote:
--   pnpm exec wrangler d1 execute moobie --local  --file=../db/migrations/001_avatar_checked_at.sql
--   pnpm exec wrangler d1 execute moobie --remote --file=../db/migrations/001_avatar_checked_at.sql
ALTER TABLE tracked_users ADD COLUMN avatar_checked_at TEXT;
