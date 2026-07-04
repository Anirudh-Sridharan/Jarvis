/**
 * Database singleton: open DatabaseSync (node:sqlite), apply schema, expose helpers.
 *
 * node:sqlite is a built-in Node ≥22 module — no native addon required.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { applySchema } from "./schema.js";

export type DB = DatabaseSync;

/** Open (or create) the memory.db file and apply the schema. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "memory.db");
  // allowExtension lets MemoryStore load sqlite-vec (optional accelerator).
  // Cast keeps the build robust across @types/node versions that may not yet
  // type the option; loading itself is attempted defensively in VecIndex.
  const db = new DatabaseSync(
    dbPath,
    { allowExtension: true, timeout: 5000 } as unknown as ConstructorParameters<typeof DatabaseSync>[1],
  );

  // WAL mode for better concurrent read performance.
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");

  applySchema(db);
  return db;
}

// ── Generic helpers ───────────────────────────────────────────────────────────

/** Serialize a value to JSON for storage. */
export function toJson(v: unknown): string {
  return JSON.stringify(v);
}

/** Deserialize JSON from storage, returning a default on failure. */
export function fromJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Generate a ULID-style ID using Node's crypto + Date. */
export function newId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rnd = Array.from(
    { length: 16 },
    () => Math.floor(Math.random() * 32).toString(32).toUpperCase(),
  ).join("");
  return (ts + rnd).slice(0, 26);
}
