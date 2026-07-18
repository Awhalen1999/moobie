/// <reference types="@cloudflare/workers-types" />

// Cloudflare bindings visible to Astro endpoints via locals.runtime.
type Runtime = import("@astrojs/cloudflare").Runtime<{
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
}>;

declare namespace App {
  interface Locals extends Runtime {}
}
