import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
  },
  plugins: [
    {
      // Vite strips "node:" from module IDs. When it sees "sqlite",
      // redirect it to a virtual module that re-exports the built-in.
      name: "node-sqlite-builtin",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") {
          // Return a virtual module ID
          return "\0virtual:node-sqlite";
        }
        return undefined;
      },
      load(id) {
        if (id === "\0virtual:node-sqlite") {
          // Use a CommonJS-compatible re-export
          return `
import { createRequire } from 'node:module';
const _req = createRequire(import.meta.url);
const nativeSqlite = _req('node:sqlite');
export const DatabaseSync = nativeSqlite.DatabaseSync;
export const StatementSync = nativeSqlite.StatementSync;
export default nativeSqlite;
`;
        }
        return undefined;
      },
    },
  ],
});
