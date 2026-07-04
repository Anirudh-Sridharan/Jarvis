// Stub for the "server-only" package under vitest.
//
// The real package (node_modules/server-only/index.js) throws unconditionally
// on import — its only purpose is a build-time guard against being bundled
// into a Client Component. That guard is meaningless (and fatal) under a
// plain Node vitest run, so this alias target (see vitest.config.ts's
// resolve.alias) replaces it with an empty module. No exports needed: the
// real module has none either — it's imported purely for its side effect.
export {};
