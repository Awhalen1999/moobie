// The last few films one person logged, newest first — what awln.dev shows as "Watching" (fetched at its build).
// Public, like the Letterboxd diary it mirrors.

import type { APIRoute } from "astro";
import { env as workerEnv } from "cloudflare:workers";
import { getEntriesForUser } from "@moobie/core";

export const prerender = false;

const env = workerEnv as unknown as { DB: D1Database };

export const GET: APIRoute = async ({ url }) => {
  const user = url.searchParams.get("user")?.toLowerCase();
  if (!user) return new Response("user required", { status: 400 });
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const entries = (await getEntriesForUser(env.DB, user)).slice(0, limit);
  const films = entries.map((e) => ({
    title: e.film_title,
    year: e.film_year,
    poster: e.poster_url,
    url: e.link,
    watched: e.watched_date,
    rating: e.rating,
    liked: !!e.liked,
    rewatch: !!e.rewatch,
  }));
  // the poll runs every 30 minutes, so nothing newer can appear before then
  return Response.json(films, { headers: { "cache-control": "public, max-age=1800" } });
};
