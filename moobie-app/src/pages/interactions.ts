// Discord interactions endpoint — the bot's inbound half. Discord POSTs every
// slash command here; we verify the Ed25519 signature on the RAW body before
// any JSON parsing (invariant #7), then route on the command name.
//
// /track runs network fetches (RSS + avatar), so it uses Discord's deferred
// reply: respond "thinking…" within the 3-second window, finish the work via
// waitUntil, then edit the reply. /untrack is one UPDATE and answers directly.

import type { APIRoute } from "astro";
import { env as workerEnv, waitUntil } from "cloudflare:workers";
import {
  addTrackedUser,
  deactivateTrackedUser,
  getAvatarUrl,
  getRecentEntries,
  insertEntries,
} from "@moobie/core";

export const prerender = false;

// Discord interaction / response type constants (the subset we use).
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED_MESSAGE = 5;

interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
}

const env = workerEnv as unknown as Env;

interface Interaction {
  type: number;
  application_id: string;
  token: string;
  data?: {
    name: string;
    options?: { name: string; value: string }[];
  };
}

export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  if (
    !signature ||
    !timestamp ||
    !(await verifySignature(env.DISCORD_PUBLIC_KEY, signature, timestamp + body))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction: Interaction = JSON.parse(body);

  if (interaction.type === PING) return json({ type: PONG });

  if (interaction.type === APPLICATION_COMMAND) {
    switch (interaction.data?.name) {
      case "track":
        return track(interaction);
      case "untrack":
        return untrack(interaction);
    }
  }

  return json({ type: MESSAGE, data: { content: "moobie doesn't know that one." } });
};

// --- commands --------------------------------------------------------------

/**
 * /track <username> [display_name] — start tracking a Letterboxd diary.
 * Defers, then: validate the feed, grab the avatar, upsert the user, and seed
 * their backlog silently (so the next poll only announces genuinely new logs).
 */
function track(interaction: Interaction): Response {
  const username = option(interaction, "username")?.trim().toLowerCase();
  const displayName = option(interaction, "display_name")?.trim() || null;

  if (!username || !/^[a-z0-9_]+$/.test(username)) {
    return json({
      type: MESSAGE,
      data: { content: `\`${username ?? ""}\` doesn't look like a Letterboxd username.` },
    });
  }

  waitUntil(finishTrack(interaction, username, displayName));
  return json({ type: DEFERRED_MESSAGE });
}

async function finishTrack(
  interaction: Interaction,
  username: string,
  displayName: string | null,
): Promise<void> {
  let content: string;
  try {
    const entries = await getRecentEntries(username); // throws if the feed 404s
    const avatarUrl = await getAvatarUrl(username);
    await addTrackedUser(env.DB, username, { displayName, avatarUrl });
    const inserted = await insertEntries(env.DB, entries);

    const shown = displayName ?? username;
    content =
      `🎬 Now tracking **${shown}** (` +
      `[letterboxd.com/${username}](https://letterboxd.com/${username}/)). ` +
      `Stored ${inserted.length} recent ${inserted.length === 1 ? "entry" : "entries"} quietly — ` +
      `new logs will be announced automatically.`;
  } catch (err) {
    // Reply stays friendly; the real error goes to the logs for forensics.
    console.error(`moobie-app: /track failed for "${username}":`, err);
    content =
      `Couldn't read \`letterboxd.com/${username}/rss/\` — ` +
      `check the spelling, and that the account's diary is public.`;
  }
  await editReply(interaction, content);
}

/** /untrack <username> — stop polling and announcing; history stays. */
async function untrack(interaction: Interaction): Promise<Response> {
  const username = option(interaction, "username")?.trim().toLowerCase() ?? "";
  const removed = await deactivateTrackedUser(env.DB, username);
  return json({
    type: MESSAGE,
    data: {
      content: removed
        ? `👋 Stopped tracking **${username}**.`
        : `**${username}** isn't currently tracked.`,
    },
  });
}

// --- plumbing ---------------------------------------------------------------

/** Verify Discord's Ed25519 signature over timestamp+rawBody (WebCrypto). */
async function verifySignature(
  publicKeyHex: string,
  signatureHex: string,
  message: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function option(interaction: Interaction, name: string): string | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

/** Edit the deferred "thinking…" reply. Auth is the interaction token itself. */
async function editReply(interaction: Interaction, content: string): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}
