import { defineConfig } from "vitest/config";

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
      resolveId(id: string) {
        if (id === "node:sqlite" || id === "sqlite") {
          return "\0virtual:node-sqlite";
        }
        return undefined;
      },
      load(id: string) {
        if (id === "\0virtual:node-sqlite") {
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
