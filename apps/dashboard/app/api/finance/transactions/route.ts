/**
 * GET /api/finance/transactions?limit=25&account=<id> — recent transactions
 * with category + account names joined in. WidgetEnvelope<TransactionContract[]>.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, TransactionContract } from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 25;
  const accountId = req.nextUrl.searchParams.get("account") ?? undefined;

  try {
    const { finance } = getIntegrations();
    const store = finance.store;
    const accounts = new Map(store.listAccounts().map((a) => [a.id, a]));
    const categories = new Map(store.listCategories().map((c) => [c.id, c]));

    const contracts: TransactionContract[] = store
      .listTransactions({ limit, accountId })
      .map((t) => {
        const cat = categories.get(t.categoryId);
        return {
          id: t.id,
          accountName: accounts.get(t.accountId)?.name ?? t.accountId,
          amountMinor: t.amountMinor,
          currency: t.currency,
          description: t.description,
          date: t.postedAt ?? t.pendingAt ?? "",
          status: t.status,
          categoryId: t.categoryId,
          categoryName: cat?.name ?? t.categoryId,
          categoryColor: cat?.color ?? "#3b82f6",
        };
      });

    const envelope: WidgetEnvelope<TransactionContract[]> = {
      data: contracts,
      state: contracts.length === 0 ? "empty" : "ok",
      meta: { source: "local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<TransactionContract[]> = {
      data: null,
      state: "error",
      error: { code: "STORE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
