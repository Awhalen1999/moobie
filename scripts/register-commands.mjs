#!/usr/bin/env node
// Register moobie's slash commands, guild-scoped (updates appear instantly).
// Re-run any time the command definitions change — PUT replaces the whole set.
//
// Usage: DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs

const APP_ID = "1527818312837370036"; // app identity — never changes
// moobie's home server; override per-server with DISCORD_GUILD_ID=... (the one
// server-specific value here — see "Moving servers" in HANDOFF.md).
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "1528008510825168966";

const STRING = 3; // Discord option type

const commands = [
  {
    name: "track",
    description: "Track a Letterboxd user's diary in this server",
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
    description: "How everyone rated a film",
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
    name: "stats",
    description: "Watching stats — the group's, or one person's",
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
    name: "vs",
    description: "Head-to-head taste comparison between two people",
    options: [
      {
        type: STRING,
        name: "user1",
        description: "First Letterboxd username",
        required: true,
      },
      {
        type: STRING,
        name: "user2",
        description: "Second Letterboxd username",
        required: true,
      },
    ],
  },
  {
    name: "refresh",
    description: "Check Letterboxd for new logs right now",
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
