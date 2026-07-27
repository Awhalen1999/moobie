# Web style

The design system for the site. Tokens live in
`moobie-app/src/styles/global.css`; this file is why they are what they are.
Direction: black / off-white minimalist brutalism, effortless polish, nothing
trying too hard. Reference vibes: gtheimagineers.com, levonaronian.com.

## Surfaces

Two themes from one token set — `[data-theme]` is stamped on `<html>` before
first paint (stored choice, else system). The toggle is a small square:
outlined in light, filled in dark.

| token | light | dark |
|---|---|---|
| `--paper` (background) | `#f2efe6` cream | `#121210` near-black |
| `--ink` (foreground) | `#161512` | `#ece9df` |
| `--muted` / `--faint` / `--line` | ink at 56% / 32% / 22% | ink at 56% / 30% / 22% |

Selection inverts (ink background, paper text).

## Type

**Tiempos Text** (Klim — the face Letterboxd uses), self-hosted woffs in
`moobie-app/public/fonts/`, licensed files only. System mono (Menlo stack) for
everything else.

**The pairing rule: mono is the app's voice, Tiempos is the films'.** UI,
labels, people's names, and data are mono; film titles, years, and star marks
are Tiempos. If text is *about the app*, it's mono; if it *is a movie*, it's
serif.

- `--font-mono` — the base font (`html` defaults to it). Small labels and
  controls wear `.mono`: 0.62rem, uppercase, 0.14em tracking.
- `--font-serif` — Tiempos Text (400, 400 italic, 700). Film titles wear
  `.display` (italic).

Text always wears text tokens (`--ink`/`--muted`), never a data color — a
colored mark next to it carries the meaning. (One deliberate exception: in
the pair card's film table, the title itself wears the pair's gap color.)

## Corners and lines

- **Hard corners everywhere** — a global `border-radius: 0` reset. The **node
  graph is the one rounded exception** (circle nodes, round avatars, and the
  matching legend chip).
- Borders are 1px: `--hairline` (22% ink) for structure, `--rule` (full ink)
  for emphasis (panels, active controls).
- Active/selected controls invert: ink background, paper text.

## Data colors

Ratings are polarity, so graph edges get a **diverging pair + neutral
midpoint** — validated with the dataviz palette checker against both surfaces
(CVD ΔE ≥ 8, contrast ≥ 3:1). Don't eyeball replacements; re-run the
validator.

| token | job | light | dark |
|---|---|---|---|
| `--low` | rating ≤ 2 | `#c73e1d` | `#e0562f` |
| `--mid` | 2.5 – 3.5 (recedes on purpose) | `#8a877c` | `#7a776c` |
| `--high` | rating ≥ 4 | `#1e7a52` | `#3fa572` |
| `--disagreed` | disagreement (spread ≥ 3) | `#b85c00` | `#e07b00` |
| `--star` / `--heart` | displayed stars / liked heart (Letterboxd's colors, both themes) | `#00e054` / `#ff9010` | same |

Rules: **orange is reserved for disagreement** (same meaning as the Discord
cards — one brain, every surface). Unrated is a dashed `--faint` line, never a
color. Identity is never color-alone: every colored mark has a legend entry.

**Displayed ratings look like Letterboxd**: green SVG stars (+ a half-width
half star) and an orange heart, inlined as `currentColor` paths in
`index.astro`. The diverging buckets color the graph itself — edges by each
rating, solo film dots by their one rating, shared film dots green
(agreement) or `--disagreed` orange (gap ≥ 3), the same green/orange call the
Discord cards make. Panels show ratings in brand colors.

The **people view** reuses the same poles pair-wise: one edge per pair who
share films, width by how many they share, color by their average rating gap
on those films (≤ 1 green, 1–2 mid, > 2 red; dashed when nothing is mutually
rated).

## Interaction

Effortless and few: hover reveals (the panel appears, a ring on the hovered
node), click focuses (a person's edges stay lit, the rest fades to near-zero),
click empty space resets — and the panel simply isn't there when nothing is
selected. No drag, no zoom, no tooltips chasing the cursor, no instructional
placeholder text. Transitions ~250ms ease; nothing bounces.
