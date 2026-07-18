// Letterboxd fetch layer — the one boundary between moobie and Letterboxd.
// v1 is RSS only. Everything downstream consumes ParsedEntry, so swapping in a
// CSV or API source later means adding a sibling function, not touching callers
// (invariant #3).
//
// The feed mixes diary watches with list items; only watches carry
// <letterboxd:watchedDate>, so that tag's presence is our filter. The real data
// lives in the letterboxd:-namespaced tags — <title> is a dirty display string
// ("Film, 2024 - ★★★½") and is never parsed.

import { XMLParser } from "fast-xml-parser";
import type { ParsedEntry } from "./types.ts";

const RSS_BASE = "https://letterboxd.com";

// parseTagValue:false keeps every leaf a string, so a film literally titled
// "1917" stays "1917" instead of becoming the number 1917. We convert the few
// numeric fields ourselves, deliberately. htmlEntities:true decodes numeric
// character references like &#039; (Letterboxd uses these for apostrophes), which
// plain entity processing leaves untouched. isArray keeps a single-item feed an
// array. ignoreAttributes collapses <guid isPermaLink="false">X</guid> to "X".
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  htmlEntities: true,
  isArray: (name) => name === "item",
});

/** Fetch and parse a user's public diary RSS. Throws on a non-OK response. */
export async function getRecentEntries(username: string): Promise<ParsedEntry[]> {
  const res = await fetch(`${RSS_BASE}/${username}/rss/`, {
    headers: { "User-Agent": "moobie (https://moobie.awln.dev)" },
  });
  if (!res.ok) {
    throw new Error(`Letterboxd RSS ${res.status} for "${username}"`);
  }
  return parseEntries(await res.text(), username);
}

/**
 * Best-effort avatar for a user, scraped from their profile page's og:image
 * meta tag (the RSS feed carries no avatar). Returns null on any failure —
 * an avatar is nice-to-have, never load-bearing.
 */
export async function getAvatarUrl(username: string): Promise<string | null> {
  try {
    const res = await fetch(`${RSS_BASE}/${username}/`, {
      headers: { "User-Agent": "moobie (https://moobie.awln.dev)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return (
      html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1] ??
      html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/** Parse raw RSS XML into diary entries. Pure — no network, easy to test. */
export function parseEntries(xml: string, username: string): ParsedEntry[] {
  const doc = parser.parse(xml);
  const items: RssItem[] = doc?.rss?.channel?.item ?? [];
  return items.map((item) => toEntry(item, username)).filter(isEntry);
}

// The subset of RSS fields we read. All values are strings (parseTagValue:false).
interface RssItem {
  guid?: string;
  link?: string;
  description?: string;
  "letterboxd:watchedDate"?: string;
  "letterboxd:rewatch"?: string;
  "letterboxd:filmTitle"?: string;
  "letterboxd:filmYear"?: string;
  "letterboxd:memberRating"?: string;
  "letterboxd:memberLike"?: string;
}

function toEntry(item: RssItem, username: string): ParsedEntry | null {
  // A watch (not a list) has a watchedDate; a guid is required to dedup.
  const watchedDate = item["letterboxd:watchedDate"];
  const guid = item.guid;
  if (!watchedDate || !guid) return null;

  const link = item.link ?? null;
  const title = item["letterboxd:filmTitle"] ?? "";
  const year = toInt(item["letterboxd:filmYear"]);

  return {
    guid,
    username,
    film_key: filmKey(link, title, year),
    film_title: title,
    film_year: year,
    poster_url: extractPoster(item.description),
    rating: toFloat(item["letterboxd:memberRating"]),
    watched_date: watchedDate,
    rewatch: item["letterboxd:rewatch"] === "Yes" ? 1 : 0,
    liked: item["letterboxd:memberLike"] === "Yes" ? 1 : 0,
    review: extractReview(item.description),
    link,
  };
}

// --- helpers -------------------------------------------------------------

function isEntry(e: ParsedEntry | null): e is ParsedEntry {
  return e !== null;
}

/**
 * The film's global slug, which every user's link to that film shares
 * (e.g. .../film/toy-story-4/ or .../film/toy-story-4/1/ for a rewatch).
 * This groups the same film across users far more reliably than title+year.
 * Falls back to a normalized title-year only if the link is unexpectedly shaped.
 */
function filmKey(link: string | null, title: string, year: number | null): string {
  const slug = link?.match(/\/film\/([^/]+)/)?.[1];
  if (slug) return slug;
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return year ? `${base}-${year}` : base;
}

/** First <img src> in the description CDATA, or null. */
function extractPoster(description: string | undefined): string | null {
  return description?.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
}

/**
 * Best-effort review text. The description CDATA is the poster <img>, a
 * "Watched on ..." line, and (if the user wrote one) the review. We drop the
 * first two and any remaining markup; whatever is left is the review, or null.
 */
function extractReview(description: string | undefined): string | null {
  if (!description) return null;
  const text = description
    .replace(/<img[^>]*>/g, "")
    .replace(/<p>\s*(Watched|Rewatched) on [^<]*<\/p>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

function toInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function toFloat(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
}
