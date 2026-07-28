// Workers runtime types for the server files — WITHOUT the usual global
// /// <reference types="@cloudflare/workers-types" />. That reference declares
// ambient names that collide with the DOM lib the client scripts compile
// against (both declare Element, Response, …), which breaks typing inside the
// .astro <script> blocks. The package's index.ts is a pure module build:
// importing types from it leaks nothing global.

/** The D1 binding, for the Env interfaces here and in @moobie/core's db. */
type D1Database = import("@cloudflare/workers-types/index.ts").D1Database;

// The subset of cloudflare:workers the app uses. The full declaration lives in
// the global types file we deliberately don't load (see above).
declare module "cloudflare:workers" {
  const env: Record<string, unknown>;
  function waitUntil(promise: Promise<unknown>): void;
  export { env, waitUntil };
}
