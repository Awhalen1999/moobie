// The one boundary between moobie and TMDB. Search only: it turns the free
// text of /rec into a real film (canonical title, year, poster, id). Letterboxd
// blocks the bot from searching, and its posters come from TMDB anyway. The
// token is the "API Read Access Token" from themoviedb.org/settings/api.

import { normalizeTitle } from "./analytics.ts";

const API_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w500";
const FETCH_TIMEOUT_MS = 10_000;

export interface TmdbFilm {
  tmdb_id: number;
  title: string;
  film_year: number | null;
  poster_url: string | null;
}

// The subset of a search result we read.
interface SearchResult {
  id: number;
  title: string;
  release_date?: string; // "2007-06-29", or "" for unreleased
  poster_path?: string | null; // "/abc.jpg"
}

/**
 * The film a title most likely means. A trailing "(1991)" narrows the search
 * to that year. An exact title match wins, else TMDB's top result. Null when
 * TMDB has nothing; throws when TMDB can't be reached, so callers can tell
 * "no such film" from "lookup failed".
 */
export async function searchTmdb(token: string, query: string): Promise<TmdbFilm | null> {
  const yearHint = query.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  const title = yearHint ? yearHint[1]! : query;

  const url = new URL(`${API_BASE}/search/movie`);
  url.searchParams.set("query", title);
  url.searchParams.set("include_adult", "false");
  if (yearHint) url.searchParams.set("year", yearHint[2]!);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TMDB ${res.status} for "${query}"`);

  const { results = [] } = (await res.json()) as { results?: SearchResult[] };
  const hit = results.find((r) => normalizeTitle(r.title) === normalizeTitle(title)) ?? results[0];
  if (!hit) return null;

  const year = Number.parseInt(hit.release_date ?? "", 10);
  return {
    tmdb_id: hit.id,
    title: hit.title,
    film_year: Number.isNaN(year) ? null : year,
    poster_url: hit.poster_path ? `${POSTER_BASE}${hit.poster_path}` : null,
  };
}
