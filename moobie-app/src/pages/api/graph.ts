// The graph payload: active people plus every film they've logged, each film
// carrying the same compareFilm() result the Discord cards use (invariant #4 —
// one brain, every surface). The client turns raters into edges.

import type { APIRoute } from "astro";
import { env as workerEnv } from "cloudflare:workers";
import { compareFilm, getActiveUsers, getAllEntries, type LogEntry } from "@moobie/core";

export const prerender = false;

interface Env {
  DB: D1Database;
}

const env = workerEnv as unknown as Env;

export const GET: APIRoute = async () => {
  const [users, entries] = await Promise.all([
    getActiveUsers(env.DB),
    getAllEntries(env.DB),
  ]);
  const active = new Set(users.map((u) => u.username));

  const byFilm = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (!active.has(e.username)) continue;
    const group = byFilm.get(e.film_key);
    if (group) group.push(e);
    else byFilm.set(e.film_key, [e]);
  }

  const films = [...byFilm.values()].map((group) => {
    const c = compareFilm(group)!;
    return {
      key: c.film_key,
      title: c.film_title,
      year: c.film_year,
      posterUrl: c.poster_url,
      average: c.average,
      spread: c.spread,
      disagreement: c.disagreement,
      raters: c.ratings.map((r) => ({
        username: r.username,
        rating: r.rating,
        liked: r.liked,
      })),
    };
  });

  const people = users.map((u) => ({
    username: u.username,
    name: u.display_name ?? u.username,
    avatarUrl: u.avatar_url,
  }));

  const logs = entries.filter((e) => active.has(e.username)).length;

  return Response.json({ people, films, logs });
};
