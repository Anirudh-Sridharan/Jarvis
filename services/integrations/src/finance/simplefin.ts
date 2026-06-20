/**
 * SimpleFIN Bridge client + normalize (feature 11).
 *
 * Read-only by design: the access URL grants GET /accounts only; no write
 * path exists anywhere in this module. Raw payloads are never logged.
 * Money: toMinor() converts source values to integer cents with explicit
 * rounding — no float math downstream.
 */

import { createHash } from "node:crypto";
import type { HttpClient } from "../types.js";
import type { Account, AccountBalance, Transaction } from "./types.js";
import { httpError } from "../framework/httpError.js";

// SimpleFIN raw payload (subset we consume)
export interface RawSimpleFinAccount {
  id: string;
  name: string;
  currency?: string;
  balance: string | number; // e.g. "1234.56"
  "balance-date"?: number; // epoch seconds
  org?: { name?: string };
  transactions?: Array<{
    id?: string;
    amount: string | number;
    description?: string;
    payee?: string;
    posted?: number; // epoch seconds; absent/0 while pending
    pending?: boolean;
  }>;
}

export interface SimpleFinPayload {
  accounts: RawSimpleFinAccount[];
  errors?: string[];
}

export class SimpleFinClient {
  readonly connectorId = "simplefin";

  constructor(
    private readonly accessUrl: string,
    private readonly http: HttpClient,
  ) {}

  /** GET {accessUrl}/accounts?start-date=… (epoch seconds). */
  async fetchAccounts(opts: { startDate: string }): Promise<SimpleFinPayload> {
    const startEpoch = Math.floor(Date.parse(opts.startDate) / 1000);
    const res = await this.http.request({
      method: "GET",
      url: `${this.accessUrl.replace(/\/$/, "")}/accounts?start-date=${startEpoch}`,
    });
    if (res.status !== 200) {
      throw httpError("SimpleFIN fetch failed", res);
    }
    return res.body as SimpleFinPayload;
  }
}

/** Convert a source money value (string/float major units) to integer cents. */
export function toMinor(value: string | number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function isoFromEpoch(epochSeconds: number | undefined): string {
  if (!epochSeconds) return new Date().toISOString();
  return new Date(epochSeconds * 1000).toISOString();
}

export function inferAccountType(name: string, org?: { name?: string }): Account["type"] {
  const t = `${name} ${org?.name ?? ""}`.toLowerCase();
  if (/credit|card/.test(t)) return "credit";
  if (/loan|mortgage/.test(t)) return "loan";
  if (/savings/.test(t)) return "savings";
  if (/invest|brokerage|401k|ira/.test(t)) return "investment";
  if (/cash/.test(t)) return "cash";
  if (/checking|chequing/.test(t)) return "checking";
  return "other";
}

/** Mask all but a leading hint of the institution name for display. */
export function maskInstitution(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 4)}…`;
}

export function stableAccountId(sourceId: string): string {
  return `sf-${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`;
}

export function internalTxnId(accountSourceId: string, txnId: string | undefined): string {
  const base = txnId ?? createHash("sha256").update(`${accountSourceId}:${Date.now()}`).digest("hex");
  return `sftx-${createHash("sha256").update(`${accountSourceId}:${base}`).digest("hex").slice(0, 20)}`;
}

/** Deterministic fallback dedupe hash when the source lacks a stable txn id. */
export function hashTxn(
  accountSourceId: string,
  postedIso: string | null,
  amount: string | number,
  description: string | undefined,
): string {
  const normalized = (description ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${accountSourceId}|${postedIso ?? ""}|${toMinor(amount)}|${normalized}`)
    .digest("hex");
}

/** Fetch + normalize to canonical types (per the feature 11 reference). */
export async function syncSimpleFin(
  client: SimpleFinClient,
  startDate: string,
): Promise<{ accounts: Account[]; balances: AccountBalance[]; txns: Transaction[] }> {
  const raw = await client.fetchAccounts({ startDate });
  const now = new Date().toISOString();
  const accounts: Account[] = [];
  const balances: AccountBalance[] = [];
  const txns: Transaction[] = [];

  for (const rawAccount of raw.accounts) {
    const type = inferAccountType(rawAccount.name, rawAccount.org);
    const accountId = stableAccountId(rawAccount.id);
    const currency = rawAccount.currency ?? "USD";
    accounts.push({
      id: accountId,
      sourceId: rawAccount.id,
      connectorId: client.connectorId,
      name: rawAccount.name,
      institution: maskInstitution(rawAccount.org?.name ?? "Unknown"),
      type,
      currency,
      isAsset: type !== "credit" && type !== "loan",
      lastSyncedAt: now,
      status: "active",
    });
    balances.push({
      accountId,
      amountMinor: toMinor(rawAccount.balance),
      currency,
      asOf: isoFromEpoch(rawAccount["balance-date"]),
      capturedAt: now,
    });
    for (const rawTxn of rawAccount.transactions ?? []) {
      const postedAt = rawTxn.posted ? isoFromEpoch(rawTxn.posted) : null;
      txns.push({
        id: internalTxnId(rawAccount.id, rawTxn.id),
        sourceTxnId: rawTxn.id ?? null,
        accountId,
        amountMinor: toMinor(rawTxn.amount),
        currency,
        description: (rawTxn.description ?? rawTxn.payee ?? "").trim(),
        postedAt,
        pendingAt: rawTxn.pending ? now : null,
        status: rawTxn.pending ? "pending" : "posted",
        categoryId: "uncategorized",
        categorySource: "none",
        dedupeHash: hashTxn(rawAccount.id, postedAt, rawTxn.amount, rawTxn.description),
      });
    }
  }
  return { accounts, balances, txns };
}
