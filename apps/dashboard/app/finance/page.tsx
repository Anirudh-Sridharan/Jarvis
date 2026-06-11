/**
 * Finance — feature 11, live SimpleFIN slice.
 * Net worth + trend, accounts with balances, 30-day spending by category,
 * income vs expenses, and recent transactions. Empty states until the first
 * `sync simplefin` run lands accounts.
 */

import type {
  WidgetEnvelope,
  FinanceOverviewContract,
  TransactionContract,
  MetricSeriesContract,
  CategorySpendContract,
} from "@/app/lib/contracts";
import { formatMinor } from "@/app/lib/money";
import MetricChart from "@/app/components/MetricChart";
import CashflowChart from "@/app/components/CashflowChart";
import { EmptyState, ErrorState } from "@/app/components/WidgetStates";

import { APP_BASE_URL as BASE } from "@/app/lib/clientEnv";

async function fetchJson<T>(path: string): Promise<WidgetEnvelope<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<T>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit",
  investment: "Investments",
  loan: "Loans",
  cash: "Cash",
  other: "Other",
};

function SpendingBars({ spending }: { spending: CategorySpendContract[] }) {
  if (spending.length === 0) {
    return <p className="text-dim">No posted spending in the last 30 days.</p>;
  }
  const max = Math.max(...spending.map((s) => s.amountMinor));
  return (
    <div className="catbar-list">
      {spending.map((s) => (
        <div key={s.categoryId} className="catbar">
          <div className="catbar__head">
            <span className="catbar__name">
              <span className="catbar__swatch" style={{ background: s.color }} />
              {s.name}
            </span>
            <span className="catbar__amount">{formatMinor(s.amountMinor, "USD")}</span>
          </div>
          <div className="catbar__track">
            <div
              className="catbar__fill"
              style={{ width: `${Math.max(2, (s.amountMinor / max) * 100)}%`, background: s.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function FinancePage() {
  const [overviewEnv, txnsEnv, trendEnv] = await Promise.all([
    fetchJson<FinanceOverviewContract>("/api/finance"),
    fetchJson<TransactionContract[]>("/api/finance/transactions?limit=25"),
    fetchJson<MetricSeriesContract>(
      "/api/metrics?metric=finance.net_worth&range=90d&domain=finance"
    ),
  ]);

  if (overviewEnv.state === "error") {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Finance</h1>
        </div>
        <ErrorState title="Finance" message={overviewEnv.error?.message} />
      </div>
    );
  }

  if (overviewEnv.state === "empty" || !overviewEnv.data) {
    return (
      <div className="page">
        <div className="page-header">
          <h1 className="page-title">Finance</h1>
          <p className="text-dim text-sm">Accounts, spending, and cash flow via SimpleFIN</p>
        </div>
        <EmptyState
          title="No accounts yet"
          message="Set SIMPLEFIN_ACCESS_URL in .env, then run a SimpleFIN sync to pull accounts, balances, and transactions."
          ctaLabel="Open integrations"
          ctaHref="/settings/integrations"
        />
      </div>
    );
  }

  const { netWorth, accounts, spending30d, cashflow } = overviewEnv.data;
  const txns = txnsEnv.data ?? [];

  // Net worth trend is stored in minor units — chart in major units
  const trendPoints = (trendEnv.data?.points ?? []).map((p) => ({
    ts: p.ts,
    value: p.value === null ? null : Math.round(p.value) / 100,
  }));

  const byType = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const group = byType.get(a.type) ?? [];
    group.push(a);
    byType.set(a.type, group);
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Finance</h1>
        <p className="text-dim text-sm">
          {accounts.length} account{accounts.length === 1 ? "" : "s"} · spending over 30d · cash
          flow over 6mo
        </p>
      </div>

      {/* Net worth band */}
      <div className="kpi-row">
        {netWorth.map((nw) => (
          <div key={nw.currency} className="kpi-card">
            <div className="kpi-card__label">Net worth ({nw.currency})</div>
            <div className="kpi-card__value">{formatMinor(nw.amountMinor, nw.currency)}</div>
            <div className="kpi-card__footer">
              <span className="kpi-card__asof">latest balances</span>
            </div>
          </div>
        ))}
      </div>

      <div className="chart-grid">
        {trendPoints.length > 0 ? (
          <div className="card">
            <MetricChart
              points={trendPoints}
              label="Net Worth Trend"
              unit={netWorth[0]?.currency ?? ""}
              kind="line"
              color="#60a5fa"
            />
          </div>
        ) : (
          <EmptyState
            title="Net Worth Trend"
            message="Trend builds up as syncs record daily net-worth points."
          />
        )}

        {cashflow.length > 0 ? (
          <div className="card">
            <CashflowChart months={cashflow} />
          </div>
        ) : (
          <EmptyState title="Income vs Expenses" message="No posted transactions in range yet." />
        )}
      </div>

      <div className="fin-grid">
        {/* Accounts */}
        <div className="card">
          <div className="card__title">Accounts</div>
          {[...byType.entries()].map(([type, group]) => (
            <div key={type} className="fin-accounts__group">
              <div className="fin-accounts__type text-dim text-sm">
                {ACCOUNT_TYPE_LABEL[type] ?? type}
              </div>
              <ul className="fin-accounts">
                {group.map((a) => (
                  <li key={a.id} className="fin-accounts__item">
                    <span className="fin-accounts__name">
                      {a.name}
                      <span className="text-dim text-sm"> · {a.institution}</span>
                      {a.status !== "active" && (
                        <span className="badge-disconnected ml">{a.status}</span>
                      )}
                    </span>
                    <span
                      className={`fin-accounts__balance${
                        (a.balanceMinor ?? 0) < 0 ? " fin-amount--neg" : ""
                      }`}
                    >
                      {a.balanceMinor === null ? "--" : formatMinor(a.balanceMinor, a.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Spending by category */}
        <div className="card">
          <div className="card__title">Spending by Category · 30d</div>
          <SpendingBars spending={spending30d} />
        </div>
      </div>

      {/* Recent transactions */}
      <div className="card">
        <div className="card__title">Recent Transactions</div>
        {txns.length === 0 ? (
          <p className="text-dim">No transactions yet.</p>
        ) : (
          <ul className="txn-list">
            {txns.map((t) => (
              <li key={t.id} className="txn-list__item">
                <span className="txn-list__date text-dim">
                  {t.date
                    ? new Date(t.date).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : "--"}
                </span>
                <span className="txn-list__desc">
                  {t.description}
                  {t.status === "pending" && <span className="badge-stale ml">pending</span>}
                </span>
                <span className="txn-list__cat">
                  <span className="catbar__swatch" style={{ background: t.categoryColor }} />
                  {t.categoryName}
                </span>
                <span
                  className={`txn-list__amount${t.amountMinor < 0 ? " fin-amount--neg" : " fin-amount--pos"}`}
                >
                  {formatMinor(t.amountMinor, t.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
