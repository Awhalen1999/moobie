// Shared card rendering for the web. The film card (poster, title, rater rows,
// avg, gap) is built once here and used by every page — graph panel, catalog.
// Colors come from token classes (.c-*) so themes keep working.

export interface Rater {
  username: string;
  rating: number | null;
  liked: number;
}
export interface Film {
  key: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  average: number | null;
  spread: number | null;
  disagreement: boolean;
  raters: Rater[];
}
export interface Person {
  username: string;
  name: string;
  avatarUrl: string | null;
}

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const num = (r: number | null) => (r === null ? "-" : `${r}`);

/** Token class for a rating gap: close is green, far is red. */
export const gapClass = (gap: number | null) =>
  gap === null ? "" : gap <= 1 ? "c-high" : gap <= 2 ? "c-mid" : "c-low";

// Letterboxd-style rating icons (user-made SVGs, inlined as currentColor).
const STAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.9121 1.59053C12.7508 1.2312 12.3936 1 11.9997 1C11.6059 1 11.2487 1.2312 11.0874 1.59053L8.27041 7.86702L1.43062 8.60661C1.03903 8.64895 0.708778 8.91721 0.587066 9.2918C0.465355 9.66639 0.574861 10.0775 0.866772 10.342L5.96556 14.9606L4.55534 21.6942C4.4746 22.0797 4.62768 22.4767 4.94632 22.7082C5.26497 22.9397 5.68983 22.9626 6.03151 22.7667L11.9997 19.3447L17.968 22.7667C18.3097 22.9626 18.7345 22.9397 19.0532 22.7082C19.3718 22.4767 19.5249 22.0797 19.4441 21.6942L18.0339 14.9606L23.1327 10.342C23.4246 10.0775 23.5341 9.66639 23.4124 9.2918C23.2907 8.91721 22.9605 8.64895 22.5689 8.60661L15.7291 7.86702L12.9121 1.59053Z" fill="currentColor"/></svg>`;
// Cropped viewBox: the half-star path only covers x 0-12, so the icon takes
// half a star's width instead of reserving a full star cell with a dead gap.
const HALF_STAR_SVG = `<svg class="half" viewBox="0 0 12 24" aria-hidden="true"><path d="M11.9997 1C11.6059 1 11.2487 1.2312 11.0874 1.59053L8.27041 7.86702L1.43062 8.60661C1.03903 8.64895 0.708778 8.91721 0.587066 9.2918C0.465355 9.66639 0.574861 10.0775 0.866772 10.342L5.96556 14.9606L4.55534 21.6942C4.4746 22.0797 4.62768 22.4767 4.94632 22.7082C5.26497 22.9397 5.68983 22.9626 6.03151 22.7667L11.9997 19.3447V1Z" fill="currentColor"/></svg>`;
const HEART_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9.1371C2 14 6.01943 16.5914 8.96173 18.9109C10 19.7294 11 20.5 12 20.5C13 20.5 14 19.7294 15.0383 18.9109C17.9806 16.5914 22 14 22 9.1371C22 4.27416 16.4998 0.825464 12 5.50063C7.50016 0.825464 2 4.27416 2 9.1371Z" fill="currentColor"/></svg>`;
const CLOSE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5L19 19M19 5L5 19" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;

/** One rating, Letterboxd-style: green stars and an orange heart. */
const ratingHtml = (rating: number | null, liked: number) => {
  const stars =
    rating === null
      ? `<span class="mono muted">unrated</span>`
      : `<span class="stars" aria-label="${rating} stars">` +
        STAR_SVG.repeat(Math.floor(rating)) +
        (rating % 1 ? HALF_STAR_SVG : "") +
        `</span>`;
  return `<span class="rating">${stars}${liked ? `<span class="heart">${HEART_SVG}</span>` : ""}</span>`;
};

/** The film card: poster, title, one row per rater, avg + gap when they mean something. */
export function filmCardHtml(f: Film, name: (username: string) => string): string {
  const rows = f.raters
    .map(
      (r) =>
        `<div class="row"><span class="mono">${esc(name(r.username))}</span>` +
        ratingHtml(r.rating, r.liked) +
        `</div>`,
    )
    .join("");
  const rated = f.raters.filter((r) => r.rating !== null).length;
  const avg =
    f.average !== null && rated > 1
      ? `<div class="row"><span class="mono">avg</span><span class="mono">${f.average}</span></div>`
      : "";
  const gap =
    f.spread !== null
      ? `<div class="row"><span class="mono">gap</span><span class="mono${f.disagreement ? " c-disagreed" : ""}">${f.spread}</span></div>`
      : "";
  return (
    `<button class="card-x" aria-label="Close">${CLOSE_SVG}</button>` +
    (f.posterUrl ? `<img class="poster" src="${esc(f.posterUrl)}" alt="" loading="lazy" />` : "") +
    `<h3 class="display">${esc(f.title)}${f.year ? ` <span class="muted">(${f.year})</span>` : ""}</h3>` +
    rows +
    avg +
    gap
  );
}
