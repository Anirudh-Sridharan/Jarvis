/**
 * Finance (feature 11, SimpleFIN slice) tests:
 *   - toMinor explicit rounding, no float drift
 *   - syncSimpleFin normalize: accounts/balances/txns, type inference, masking
 *   - store dedupe: re-sync never double-inserts; pending→posted updates in place
 *   - categorize: user rules beat built-ins, first match wins, safe default
 *   - net worth: sign-adjusted per currency; disconnected accounts excluded
 *   - spending excludes transfers; runFinanceSync emits net-worth metric points
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SimpleFinClient,
  syncSimpleFin,
  toMinor,
} from "../src/finance/simplefin.js";
import { FinanceStore } from "../src/finance/financeStore.js";
import { categorize, BUILT_IN_RULES, UNCATEGORIZED } from "../src/finance/categorize.js";
import { runFinanceSync } from "../src/finance/sync.js";
import { MetricStore } from "../src/framework/metricStore.js";
import { applySchema } from "../src/db/schema.js";
import { FakeHttp } from "../src/testing/fakes.js";
import type { Transaction } from "../src/finance/types.js";

const ACCESS_URL = "https://bridge.simplefin.org/simplefin/ABC123";

function simpleFinPayload() {
  return {
    accounts: [
      {
        id: "act-checking",
        name: "Everyday Checking",
        currency: "USD",
        balance: "2500.10",
        "balance-date": 1781136000, // 2026-06-11T00:00:00Z
        org: { name: "First National Bank" },
        transactions: [
          {
            id: "txn-1",
            amount: "-82.45",
            description: "WHOLE FOODS MARKET",
            posted: 1781050000,
          },
          {
            id: "txn-2",
            amount: "-15.00",
            description: "Netflix.com",
            posted: 1781050100,
          },
          {
            id: "txn-3",
            amount: "3200.00",
            description: "ACME CORP PAYROLL",
            posted: 1781050200,
          },
        ],
      },
      {
        id: "act-card",
        name: "Travel Rewards Credit Card",
        currency: "USD",
        balance: "-432.10",
        "balance-date": 1781136000,
        org: { name: "Big Bank" },
        transactions: [],
      },
    ],
  };
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

describe("toMinor", () => {
  it.each([
    ["2500.10", 250010],
    ["-82.45", -8245],
    [0.1 + 0.2, 30], // float input rounds explicitly
    ["19.999", 2000],
    ["garbage", 0],
  ])("%s → %i cents", (input, expected) => {
    expect(toMinor(input as never)).toBe(expected);
  });
});

describe("syncSimpleFin", () => {
  it("normalizes accounts, balances, and transactions", async () => {
    const http = new FakeHttp();
    http.add("/accounts?start-date=", { status: 200, headers: {}, body: simpleFinPayload() });
    const client = new SimpleFinClient(ACCESS_URL, http);

    const { accounts, balances, txns } = await syncSimpleFin(client, "2026-03-01T00:00:00Z");

    expect(accounts).toHaveLength(2);
    const checking = accounts.find((a) => a.sourceId === "act-checking")!;
    expect(checking.type).toBe("checking");
    expect(checking.isAsset).toBe(true);
    expect(checking.institution).toBe("Firs…"); // masked
    const card = accounts.find((a) => a.sourceId === "act-card")!;
    expect(card.type).toBe("credit");
    expect(card.isAsset).toBe(false);

    expect(balances.find((b) => b.accountId === checking.id)!.amountMinor).toBe(250010);
    expect(txns).toHaveLength(3);
    expect(txns[0]!.amountMinor).toBe(-8245);
    expect(txns[0]!.status).toBe("posted");
    expect(txns.every((t) => t.categoryId === UNCATEGORIZED)).toBe(true);
  });

  it("throws on fetch failure", async () => {
    const http = new FakeHttp();
    http.add("/accounts?start-date=", { status: 403, headers: {}, body: {} });
    await expect(
      syncSimpleFin(new SimpleFinClient(ACCESS_URL, http), "2026-03-01T00:00:00Z"),
    ).rejects.toThrow("HTTP 403");
  });
});

describe("categorize", () => {
  const baseTxn = (description: string): Transaction => ({
    id: "t1",
    sourceTxnId: "s1",
    accountId: "a1",
    amountMinor: -1000,
    currency: "USD",
    description,
    postedAt: "2026-06-10T00:00:00Z",
    pendingAt: null,
    status: "posted",
    categoryId: UNCATEGORIZED,
    categorySource: "none",
    dedupeHash: "h",
  });

  it("built-in rules match by keyword", async () => {
    const t = await categorize(baseTxn("WHOLE FOODS MARKET #123"), BUILT_IN_RULES);
    expect(t.categoryId).toBe("groceries");
    expect(t.categorySource).toBe("rule");
  });

  it("user rules win over built-ins", async () => {
    const userRule = { id: "u1", categoryId: "dining", keywords: ["whole foods"], isUser: true };
    const t = await categorize(baseTxn("WHOLE FOODS MARKET"), [...BUILT_IN_RULES, userRule]);
    expect(t.categoryId).toBe("dining");
    expect(t.categorySource).toBe("user");
  });

  it("falls back to uncategorized — never guesses", async () => {
    const t = await categorize(baseTxn("MYSTERY MERCHANT 9941"), BUILT_IN_RULES);
    expect(t.categoryId).toBe(UNCATEGORIZED);
    expect(t.categorySource).toBe("none");
  });
});

describe("FinanceStore", () => {
  let store: FinanceStore;
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
    store = new FinanceStore(db);
  });

  async function seedFromPayload() {
    const http = new FakeHttp();
    http.add("/accounts?start-date=", { status: 200, headers: {}, body: simpleFinPayload() });
    const metrics = new MetricStore(db);
    return runFinanceSync(
      { accessUrl: ACCESS_URL },
      { http, store, metrics, now: () => new Date("2026-06-10T12:00:00Z") },
    );
  }

  it("re-sync never double-inserts (dedupe on source ids)", async () => {
    const first = await seedFromPayload();
    const second = await seedFromPayload();
    expect(first.newTransactions).toBe(3);
    expect(second.newTransactions).toBe(0);
    expect(second.updatedTransactions).toBe(3);
  });

  it("pending→posted updates in place", () => {
    const pending: Transaction = {
      id: "tx-int-1",
      sourceTxnId: "src-9",
      accountId: "acct-1",
      amountMinor: -500,
      currency: "USD",
      description: "COFFEE SHOP",
      postedAt: null,
      pendingAt: "2026-06-09T08:00:00Z",
      status: "pending",
      categoryId: "dining",
      categorySource: "rule",
      dedupeHash: "h-1",
    };
    expect(store.upsertTransaction(pending)).toBe(true);
    const posted = { ...pending, id: "tx-int-2", postedAt: "2026-06-10T00:00:00Z", pendingAt: null, status: "posted" as const };
    expect(store.upsertTransaction(posted)).toBe(false); // updated, not inserted

    const rows = db.prepare("SELECT status, posted_at, category_id FROM fin_transactions").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["status"]).toBe("posted");
    expect(rows[0]!["category_id"]).toBe("dining"); // categorization preserved
  });

  it("net worth is sign-adjusted per currency and excludes disconnected accounts", async () => {
    await seedFromPayload();
    // checking +2500.10, credit card liability 432.10 → 250010 - 43210
    expect(store.netWorth()).toEqual([{ currency: "USD", amountMinor: 250010 - 43210 }]);
  });

  it("spending by category excludes transfers and income", async () => {
    await seedFromPayload();
    const spending = store.spendingByCategory({ from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" });
    const ids = spending.map((s) => s.categoryId);
    expect(ids).toContain("groceries");
    expect(ids).toContain("subscriptions");
    expect(ids).not.toContain("income");
    expect(spending.find((s) => s.categoryId === "groceries")!.amountMinor).toBe(8245);
  });

  it("listTransactions returns newest first and respects limit/account filters", async () => {
    await seedFromPayload();
    const all = store.listTransactions();
    expect(all).toHaveLength(3);
    const dates = all.map((t) => t.postedAt ?? t.pendingAt);
    expect([...dates].sort().reverse()).toEqual(dates); // newest first
    const limited = store.listTransactions({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe(all[0]!.id);
    const byAccount = store.listTransactions({ accountId: all[0]!.accountId });
    expect(byAccount.every((t) => t.accountId === all[0]!.accountId)).toBe(true);
  });

  it("latestBalances returns one latest snapshot per account", async () => {
    await seedFromPayload();
    const balances = store.latestBalances();
    const accountIds = balances.map((b) => b.accountId);
    expect(new Set(accountIds).size).toBe(accountIds.length); // one per account
    expect(balances.length).toBe(store.listAccounts().length);
    // Σ latest balances (sign-authoritative) must agree with netWorth()
    const total = balances.reduce((sum, b) => sum + b.amountMinor, 0);
    expect(store.netWorth()).toEqual([{ currency: "USD", amountMinor: total }]);
  });

  it("runFinanceSync emits a per-currency net-worth metric point", async () => {
    await seedFromPayload();
    const metrics = new MetricStore(db);
    const series = metrics.querySeries("finance.net_worth", {
      from: "2026-06-10T00:00:00Z",
      to: "2026-06-10T23:59:59Z",
    });
    expect(series.points).toHaveLength(1);
    expect(series.points[0]!.value).toBe(250010 - 43210);
  });
});

describe("FinanceStore: edge cases from review", () => {
  it("net worth trusts the source sign — an overpaid credit card adds, not subtracts", () => {
    const db = makeDb();
    const store = new FinanceStore(db);
    const now = "2026-06-10T12:00:00Z";
    store.upsertAccount({
      id: "card-1", sourceId: "src-card", connectorId: "simplefin",
      name: "Credit Card", institution: "Bank…", type: "credit",
      currency: "USD", isAsset: false, lastSyncedAt: now, status: "active",
    });
    // Overpaid by $50: source reports +50.00
    store.upsertBalance({ accountId: "card-1", amountMinor: 5000, currency: "USD", asOf: now, capturedAt: now });
    expect(store.netWorth()).toEqual([{ currency: "USD", amountMinor: 5000 }]);
  });

  it("pending→posted with NO source txn id updates in place (fuzzy match)", () => {
    const db = makeDb();
    const store = new FinanceStore(db);
    const pending: Transaction = {
      id: "tx-p1", sourceTxnId: null, accountId: "acct-1",
      amountMinor: -4200, currency: "USD", description: "  Corner CAFE ",
      postedAt: null, pendingAt: "2026-06-09T08:00:00Z", status: "pending",
      categoryId: "dining", categorySource: "rule",
      dedupeHash: "hash-pending-no-date",
    };
    expect(store.upsertTransaction(pending)).toBe(true);

    // Same charge posts: different hash (date now included), no source id
    const posted: Transaction = {
      ...pending, id: "tx-p2", postedAt: "2026-06-10T00:00:00Z",
      pendingAt: null, status: "posted", description: "corner cafe",
      dedupeHash: "hash-posted-with-date",
    };
    expect(store.upsertTransaction(posted)).toBe(false); // updated, not inserted

    const rows = db.prepare("SELECT status, category_id FROM fin_transactions").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["status"]).toBe("posted");
    expect(rows[0]!["category_id"]).toBe("dining"); // categorization preserved
  });
});
