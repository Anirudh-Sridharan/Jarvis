/** Monorepo root = nearest ancestor package.json declaring workspaces. */

import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

export function findRepoRoot(): string {
  if (cached) return cached;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      if (pkg.workspaces) {
        cached = dir;
        return dir;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.cwd();
  return cached;
}
