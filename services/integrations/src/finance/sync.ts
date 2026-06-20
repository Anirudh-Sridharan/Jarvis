/**
 * Finance sync orchestration (feature 11): fetch → normalize → categorize →
 * upsert → emit net-worth MetricPoints so the dashboard/briefing consume
 * finance like any other metric. Deterministic; re-fetch overlap is absorbed
 * by the store's dedupe.
 */

import type { HttpClient, MetricPoint } from "../types.js";
import { makeMetricId } from "../framework/metricStore.js";
import type { MetricStore } from "../framework/metricStore.js";
import { SimpleFinClient, syncSimpleFin } from "./simplefin.js";
import { categorize, BUILT_IN_RULES } from "./categorize.js";
import type { FinanceStore } from "./financeStore.js";
import type { CategoryRule } from "./types.js";

const DAY_MS = 86_400_000;
/** Initial backfill window; incremental syncs overlap by 7 days (edge case 1). */
const DEFAULT_BACKFILL_DAYS = 90;
const OVERLAP_DAYS = 7;

export interface FinanceSyncDeps {
  http: HttpClient;
  store: FinanceStore;
  metrics: MetricStore;
  now?: () => Date;
  userRules?: CategoryRule[];
}

export interface FinanceSyncResult {
  accounts: number;
  newTransactions: number;
  updatedTransactions: number;
  netWorth: Array<{ currency: string; amountMinor: number }>;
}

/**
 * Run one finance sync: fetch from SimpleFIN, normalize + categorize, upsert
 * accounts/balances/transactions, and emit a per-currency net-worth metric
 * point for the day. Idempotent — `startDate` defaults to a 90-day backfill
 * (plus a 7-day overlap on incremental runs) and the store's dedupe absorbs
 * the re-fetched overlap, so repeated runs don't double-count.
 */
export async function runFinanceSync(
  opts: { accessUrl: string; startDate?: string },
  deps: FinanceSyncDeps,
): Promise<FinanceSyncResult> {
  const now = deps.now?.() ?? new Date();
  const startDate =
    opts.startDate ??
    new Date(now.getTime() - (DEFAULT_BACKFILL_DAYS + OVERLAP_DAYS) * DAY_MS).toISOString();

  const client = new SimpleFinClient(opts.accessUrl, deps.http);
  const { accounts, balances, txns } = await syncSimpleFin(client, startDate);

  for (const account of accounts) deps.store.upsertAccount(account);
  for (const balance of balances) deps.store.upsertBalance(balance);

  // User rules sort ahead of built-ins so a personal override wins (see categorize).
  const rules = [...(deps.userRules ?? []), ...BUILT_IN_RULES];
  let inserted = 0;
  let updated = 0;
  for (const txn of txns) {
    const categorized = await categorize(txn, rules);
    if (deps.store.upsertTransaction(categorized)) inserted++;
    else updated++;
  }

  // Emit per-currency net worth as a daily metric point (deterministic id →
  // same-day re-syncs upsert instead of appending).
  const netWorth = deps.store.netWorth();
  const day = now.toISOString().slice(0, 10);
  const ts = `${day}T00:00:00Z`;
  const points: MetricPoint[] = netWorth.map((entry) => ({
    id: makeMetricId({
      source: "simplefin",
      metric: "finance.net_worth",
      ts,
      dims: { currency: entry.currency },
    }),
    source: "simplefin",
    metric: "finance.net_worth",
    value: entry.amountMinor,
    unit: "minor",
    ts,
    dims: { currency: entry.currency },
    ingestedAt: now.toISOString(),
    adapterVersion: "1",
  }));
  if (points.length > 0) deps.metrics.upsertSeries(points);

  return {
    accounts: accounts.length,
    newTransactions: inserted,
    updatedTransactions: updated,
    netWorth,
  };
}
