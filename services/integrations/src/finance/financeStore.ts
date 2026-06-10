/**
 * Finance store (feature 11): accounts / balances / transactions / categories
 * in the shared SQLite DB. Deterministic invariants:
 *   - reported balances are AUTHORITATIVE (never derived from txn sums)
 *   - net worth = Σ latest balances (source sign authoritative — SimpleFIN
 *     reports debt negative), computed PER CURRENCY (no FX in this slice)
 *   - dedupe on (accountId, sourceTxnId), hash fallback; pending→posted
 *     updates in place — upsert never double-inserts
 *   - transfers are excluded from income/expense/spending aggregates
 */

import type { DatabaseSync } from "node:sqlite";
import type { Account, AccountBalance, Category, Transaction } from "./types.js";
import { BUILT_IN_CATEGORIES } from "./categorize.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fin_accounts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  is_asset INTEGER NOT NULL,
  last_synced_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fin_balances (
  account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  as_of TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (account_id, as_of)
);
CREATE TABLE IF NOT EXISTS fin_transactions (
  id TEXT PRIMARY KEY,
  source_txn_id TEXT,
  account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  posted_at TEXT,
  pending_at TEXT,
  status TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_source TEXT NOT NULL,
  category_confidence REAL,
  dedupe_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_txn_source
  ON fin_transactions(account_id, source_txn_id) WHERE source_txn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_txn_hash ON fin_transactions(dedupe_hash);
CREATE TABLE IF NOT EXISTS fin_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  parent_id TEXT,
  color TEXT NOT NULL,
  is_built_in INTEGER NOT NULL
);
`;

export class FinanceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
    this.seedCategories();
  }

  private seedCategories(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO fin_categories (id, name, grp, parent_id, color, is_built_in)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of BUILT_IN_CATEGORIES) {
      insert.run(c.id, c.name, c.group, c.parentId, c.color, c.isBuiltIn ? 1 : 0);
    }
  }

  upsertAccount(a: Account): void {
    this.db
      .prepare(
        `INSERT INTO fin_accounts
           (id, source_id, connector_id, name, institution, type, currency, is_asset, last_synced_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, institution = excluded.institution,
           type = excluded.type, currency = excluded.currency,
           is_asset = excluded.is_asset, last_synced_at = excluded.last_synced_at,
           status = excluded.status`,
      )
      .run(
        a.id, a.sourceId, a.connectorId, a.name, a.institution, a.type,
        a.currency, a.isAsset ? 1 : 0, a.lastSyncedAt, a.status,
      );
  }

  /** Balance snapshots keyed (account, asOf) — re-syncs overwrite in place. */
  upsertBalance(b: AccountBalance): void {
    this.db
      .prepare(
        `INSERT INTO fin_balances (account_id, amount_minor, currency, as_of, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, as_of) DO UPDATE SET
           amount_minor = excluded.amount_minor, captured_at = excluded.captured_at`,
      )
      .run(b.accountId, b.amountMinor, b.currency, b.asOf, b.capturedAt);
  }

  /**
   * Dedupe-aware upsert. Match priority: (accountId, sourceTxnId) → dedupeHash.
   * A matched row is UPDATED in place (pending→posted transitions included);
   * category fields are only overwritten when the existing row is
   * uncategorized (user/rule decisions are never clobbered by a re-sync).
   * Returns true when a new row was inserted.
   */
  upsertTransaction(t: Transaction): boolean {
    const existing = (
      t.sourceTxnId
        ? this.db
            .prepare(`SELECT id, category_id FROM fin_transactions WHERE account_id = ? AND source_txn_id = ?`)
            .get(t.accountId, t.sourceTxnId)
        : undefined
    ) ??
      this.db
        .prepare(`SELECT id, category_id FROM fin_transactions WHERE dedupe_hash = ?`)
        .get(t.dedupeHash) ??
      // Pending→posted fuzzy match (spec edge case 3): a pending txn whose
      // hash included no posted date won't hash-match once it posts. Match a
      // PENDING row on the same account with the same amount + normalized
      // description within a small window, and update it in place instead of
      // inserting a phantom duplicate.
      (t.status === "posted"
        ? this.db
            .prepare(
              `SELECT id, category_id FROM fin_transactions
               WHERE account_id = ? AND status = 'pending' AND amount_minor = ?
                 AND lower(trim(description)) = lower(trim(?))`,
            )
            .get(t.accountId, t.amountMinor, t.description)
        : undefined);

    if (existing) {
      const keepCategory = (existing as { category_id: string }).category_id !== "uncategorized";
      this.db
        .prepare(
          `UPDATE fin_transactions SET
             amount_minor = ?, description = ?, posted_at = ?, pending_at = ?,
             status = ?, dedupe_hash = ?, source_txn_id = COALESCE(source_txn_id, ?)
             ${keepCategory ? "" : ", category_id = ?, category_source = ?, category_confidence = ?"}
           WHERE id = ?`,
        )
        .run(
          ...(keepCategory
            ? [t.amountMinor, t.description, t.postedAt, t.pendingAt, t.status, t.dedupeHash, t.sourceTxnId, (existing as { id: string }).id]
            : [t.amountMinor, t.description, t.postedAt, t.pendingAt, t.status, t.dedupeHash, t.sourceTxnId, t.categoryId, t.categorySource, t.categoryConfidence ?? null, (existing as { id: string }).id]),
        );
      return false;
    }

    this.db
      .prepare(
        `INSERT INTO fin_transactions
           (id, source_txn_id, account_id, amount_minor, currency, description,
            posted_at, pending_at, status, category_id, category_source, category_confidence, dedupe_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.sourceTxnId, t.accountId, t.amountMinor, t.currency, t.description,
        t.postedAt, t.pendingAt, t.status, t.categoryId, t.categorySource,
        t.categoryConfidence ?? null, t.dedupeHash,
      );
    return true;
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare(`SELECT * FROM fin_accounts ORDER BY name`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r["id"] as string,
      sourceId: r["source_id"] as string,
      connectorId: r["connector_id"] as string,
      name: r["name"] as string,
      institution: r["institution"] as string,
      type: r["type"] as Account["type"],
      currency: r["currency"] as string,
      isAsset: r["is_asset"] === 1,
      lastSyncedAt: r["last_synced_at"] as string,
      status: r["status"] as Account["status"],
    }));
  }

  /** Recent transactions, newest first (posted date, pending date fallback). */
  listTransactions(opts: { limit?: number; accountId?: string } = {}): Transaction[] {
    const limit = opts.limit ?? 50;
    const where = opts.accountId ? "WHERE account_id = ?" : "";
    const params = opts.accountId ? [opts.accountId, limit] : [limit];
    const rows = this.db
      .prepare(
        `SELECT * FROM fin_transactions ${where}
         ORDER BY COALESCE(posted_at, pending_at) DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r["id"] as string,
      sourceTxnId: (r["source_txn_id"] as string | null) ?? null,
      accountId: r["account_id"] as string,
      amountMinor: r["amount_minor"] as number,
      currency: r["currency"] as string,
      description: r["description"] as string,
      postedAt: (r["posted_at"] as string | null) ?? null,
      pendingAt: (r["pending_at"] as string | null) ?? null,
      status: r["status"] as Transaction["status"],
      categoryId: r["category_id"] as string,
      categorySource: r["category_source"] as Transaction["categorySource"],
      categoryConfidence: (r["category_confidence"] as number | null) ?? undefined,
      dedupeHash: r["dedupe_hash"] as string,
    }));
  }

  listCategories(): Category[] {
    const rows = this.db.prepare(`SELECT * FROM fin_categories`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r["id"] as string,
      name: r["name"] as string,
      group: r["grp"] as Category["group"],
      parentId: (r["parent_id"] as string | null) ?? null,
      color: r["color"] as string,
      isBuiltIn: r["is_built_in"] === 1,
    }));
  }

  /** Latest balance snapshot per account (all accounts, any status). */
  latestBalances(): Array<{ accountId: string; amountMinor: number; currency: string; asOf: string }> {
    const rows = this.db
      .prepare(
        `SELECT account_id, amount_minor, currency, as_of FROM fin_balances b
         WHERE as_of = (SELECT MAX(as_of) FROM fin_balances WHERE account_id = b.account_id)`,
      )
      .all() as Array<{ account_id: string; amount_minor: number; currency: string; as_of: string }>;
    return rows.map((r) => ({
      accountId: r.account_id,
      amountMinor: r.amount_minor,
      currency: r.currency,
      asOf: r.as_of,
    }));
  }

  /**
   * Net worth per currency: Σ latest balance per ACTIVE/reauth account.
   * The source's sign is AUTHORITATIVE — SimpleFIN reports debt as a negative
   * balance, and abs-forcing liabilities would turn an overpaid credit card's
   * genuine +credit into phantom debt. Disconnected accounts are excluded
   * from current totals (history retained).
   */
  netWorth(): Array<{ currency: string; amountMinor: number }> {
    const rows = this.db
      .prepare(
        `SELECT a.currency AS currency, a.is_asset AS is_asset, b.amount_minor AS amount
         FROM fin_accounts a
         JOIN fin_balances b ON b.account_id = a.id
         WHERE a.status != 'disconnected'
           AND b.as_of = (SELECT MAX(as_of) FROM fin_balances WHERE account_id = a.id)`,
      )
      .all() as Array<{ currency: string; is_asset: number; amount: number }>;

    const byCurrency = new Map<string, number>();
    for (const r of rows) {
      byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.amount);
    }
    return [...byCurrency.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));
  }

  /** Spending by category over a window — posted outflows only, transfers excluded. */
  spendingByCategory(range: { from: string; to: string }): Array<{ categoryId: string; amountMinor: number }> {
    const rows = this.db
      .prepare(
        `SELECT t.category_id AS category_id, SUM(-t.amount_minor) AS spent
         FROM fin_transactions t
         JOIN fin_categories c ON c.id = t.category_id
         WHERE t.status = 'posted' AND t.amount_minor < 0
           AND c.grp != 'transfer'
           AND t.posted_at >= ? AND t.posted_at <= ?
         GROUP BY t.category_id
         ORDER BY spent DESC`,
      )
      .all(range.from, range.to) as Array<{ category_id: string; spent: number }>;
    return rows.map((r) => ({ categoryId: r.category_id, amountMinor: r.spent }));
  }

  /** Income vs expenses per month (YYYY-MM) — transfers excluded. */
  incomeVsExpenses(range: { from: string; to: string }): Array<{
    month: string;
    incomeMinor: number;
    expensesMinor: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT substr(t.posted_at, 1, 7) AS month,
                SUM(CASE WHEN t.amount_minor > 0 THEN t.amount_minor ELSE 0 END) AS income,
                SUM(CASE WHEN t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END) AS expenses
         FROM fin_transactions t
         JOIN fin_categories c ON c.id = t.category_id
         WHERE t.status = 'posted' AND c.grp != 'transfer'
           AND t.posted_at >= ? AND t.posted_at <= ?
         GROUP BY month ORDER BY month`,
      )
      .all(range.from, range.to) as Array<{ month: string; income: number; expenses: number }>;
    return rows.map((r) => ({ month: r.month, incomeMinor: r.income, expensesMinor: r.expenses }));
  }
}
