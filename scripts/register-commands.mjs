#!/usr/bin/env node
// Register moobie's slash commands, guild-scoped (updates appear instantly).
// Re-run any time the command definitions change — PUT replaces the whole set.
//
// Usage: DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs

const APP_ID = "1527818312837370036"; // app identity — never changes
// moobie's home server; override per-server with DISCORD_GUILD_ID=... (the one
// server-specific value here — see "Moving servers" in PLAN.md).
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "1528008510825168966";

const STRING = 3; // Discord option type

const commands = [
  {
    name: "track",
    description: "Add a Letterboxd user's feed to the pool",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
      {
        type: STRING,
        name: "display_name",
        description: "Friendly name to show on cards (optional)",
        required: false,
      },
    ],
  },
  {
    name: "untrack",
    description: "Stop tracking a Letterboxd user",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
    ],
  },
  {
    name: "film",
    description: "How the pool rated a film",
    options: [
      {
        type: STRING,
        name: "title",
        description: "Film title to look up",
        required: true,
      },
    ],
  },
  {
    name: "film-key",
    description: "Exact film lookup by its Letterboxd URL slug",
    options: [
      {
        type: STRING,
        name: "key",
        description: "The slug from the film's URL: letterboxd.com/film/<key>/",
        required: true,
      },
    ],
  },
  {
    name: "review",
    description: "One person's latest log of a film - rating, heart, review",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
      {
        type: STRING,
        name: "title",
        description: "Film title to look up",
        required: true,
      },
    ],
  },
  {
    name: "review-key",
    description: "Same as /review, by the film's Letterboxd URL slug",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
      {
        type: STRING,
        name: "key",
        description: "The slug from the film's URL: letterboxd.com/film/<key>/",
        required: true,
      },
    ],
  },
  {
    name: "best",
    description: "The films a person rated highest",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
    ],
  },
  {
    name: "worst",
    description: "The films a person rated lowest",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
    ],
  },
  {
    name: "favorite",
    description: "Every film a person has liked",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Their Letterboxd username",
        required: true,
      },
    ],
  },
  {
    name: "stats",
    description: "Logging stats - the pool's, or one person's",
    options: [
      {
        type: STRING,
        name: "username",
        description: "Letterboxd username (optional)",
        required: false,
      },
    ],
  },
  {
    name: "refresh",
    description: "Check the pool's feeds for new logs right now",
  },
];

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("Set DISCORD_BOT_TOKEN in the environment first.");
  process.exit(1);
}

const res = await fetch(
  `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  },
);

if (!res.ok) {
  console.error(`Discord ${res.status}:`, await res.text());
  process.exit(1);
}

const registered = await res.json();
console.log(
  `Registered ${registered.length} command(s):`,
  registered.map((c) => `/${c.name}`).join("  "),
);
