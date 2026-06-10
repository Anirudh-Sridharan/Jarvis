/**
 * GET /api/finance — finance overview (feature 11 surface).
 *
 * Net worth per currency, accounts with latest balances, 30-day spending by
 * category, and 6-month income vs expenses — all from the local FinanceStore.
 * Returns WidgetEnvelope<FinanceOverviewContract>; state:"empty" until the
 * first SimpleFIN sync lands accounts.
 */

import { NextResponse } from "next/server";
import type {
  WidgetEnvelope,
  FinanceOverviewContract,
  AccountContract,
  CategorySpendContract,
} from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

const DAY_MS = 86_400_000;

export async function GET() {
  const t0 = Date.now();
  try {
    const { finance } = getIntegrations();
    const store = finance.store;

    const accounts = store.listAccounts();
    const balances = new Map(store.latestBalances().map((b) => [b.accountId, b]));
    const categories = new Map(store.listCategories().map((c) => [c.id, c]));

    const now = new Date();
    const from30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const from6mo = new Date(now.getTime() - 183 * DAY_MS).toISOString();
    const to = now.toISOString();

    const accountContracts: AccountContract[] = accounts.map((a) => {
      const bal = balances.get(a.id);
      return {
        id: a.id,
        name: a.name,
        institution: a.institution,
        type: a.type,
        currency: a.currency,
        isAsset: a.isAsset,
        balanceMinor: bal?.amountMinor ?? null,
        balanceAsOf: bal?.asOf ?? null,
        lastSyncedAt: a.lastSyncedAt,
        status: a.status,
      };
    });

    const spending30d: CategorySpendContract[] = store
      .spendingByCategory({ from: from30, to })
      .map((s) => {
        const cat = categories.get(s.categoryId);
        return {
          categoryId: s.categoryId,
          name: cat?.name ?? s.categoryId,
          color: cat?.color ?? "#3b82f6",
          amountMinor: s.amountMinor,
        };
      });

    const data: FinanceOverviewContract = {
      netWorth: store.netWorth(),
      accounts: accountContracts,
      spending30d,
      cashflow: store.incomeVsExpenses({ from: from6mo, to }),
    };

    const envelope: WidgetEnvelope<FinanceOverviewContract> = {
      data: accounts.length === 0 ? null : data,
      state: accounts.length === 0 ? "empty" : "ok",
      meta: { source: "local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<FinanceOverviewContract> = {
      data: null,
      state: "error",
      error: { code: "STORE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
