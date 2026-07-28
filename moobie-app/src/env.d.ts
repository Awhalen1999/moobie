// Workers types without the usual global workers-types reference — its
// ambient names collide with the DOM lib the client scripts compile against
// (both declare Element, Response, …). The package's index.ts is a pure
// module build, so importing types from it leaks nothing global.

/** The D1 binding, for the Env interfaces here and in @moobie/core. */
type D1Database = import("@cloudflare/workers-types/index.ts").D1Database;

// The slice of cloudflare:workers the app uses.
declare module "cloudflare:workers" {
  const env: Record<string, unknown>;
  function waitUntil(promise: Promise<unknown>): void;
  export { env, waitUntil };
}
