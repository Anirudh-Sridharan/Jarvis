/**
 * Database singleton for @jarvis/integrations.
 * Uses built-in node:sqlite (Node ≥22) — no native addons.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { applySchema } from "./schema.js";

export type DB = DatabaseSync;

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "integrations.db");
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");

  applySchema(db);
  return db;
}

export function toJson(v: unknown): string {
  return JSON.stringify(v);
}

export function fromJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Generate a simple time-prefixed ID (no external deps). */
export function newId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rnd = Array.from(
    { length: 16 },
    () => Math.floor(Math.random() * 32).toString(32).toUpperCase(),
  ).join("");
  return (ts + rnd).slice(0, 26);
}
