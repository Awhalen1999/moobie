# Language

One vocabulary, used everywhere moobie speaks — Discord and web. (Code and
docs may use Letterboxd's own terms — e.g. "diary" — only when describing
*their* API surface; schema names keep their semantics: `watched_date`,
`log_entries`.)

| term | means |
|------|-------|
| **log** | one watch of one film by one person — the row. Exists with or without a rating/review. Display dates say "Logged". |
| **rating** | the stars (0.5–5.0); optional property of a log |
| **review** | the written text; optional property of a log |
| **liked** | the ❤️, from `letterboxd:memberLike` |
| **rewatch** | the 🔁, from `letterboxd:rewatch` |
| **feed** | a user's Letterboxd RSS source (never "diary" in bot text) |
| **pool** | the tracked people and their data — one pool, shared across servers |
| **server** | a Discord place moobie speaks in; joining/leaving never touches the pool |
| **favorite** | a film someone liked — shown at its most recent liked log |
| **track / untrack** | add a feed to the pool / soft-disable it |
| **card** | any embed moobie posts |
| **Biggest gap** | the disagreement field: the two extreme raters, shown when spread ≥ 3 |

## Voice

Plain short sentences, nothing trying to be funny. Misses end in "yet" and
carry no emoji; successes get exactly one leading emoji (🎬 👋 ✅). Never name
the machinery (Workers, polling, RSS internals) in a reply. Passive is fine;
system-speak ("automatically", "currently") is not. Bot-facing text uses plain
hyphens, never em-dashes.

Web copy follows the same voice; the type rules for it live in
[style.md](./style.md).
