/**
 * Dashboard data contracts — feature 14.
 * All BFF /api/* route handlers return WidgetEnvelope<T>.
 * UI code only knows these types; it never imports @jarvis/integrations directly.
 */

// ── Core envelope ─────────────────────────────────────────────────────────────

export interface WidgetEnvelope<T> {
  data: T | null;
  state: "ok" | "empty" | "stale" | "error" | "placeholder";
  error?: { code: string; message: string };
  meta: { source: string; fetchedAt: string; latencyMs: number };
}

// ── Metric / KPI ──────────────────────────────────────────────────────────────

export interface MetricPoint {
  ts: string;   // ISO-8601
  value: number | null;
}

export interface MetricSeriesContract {
  metricId: string;
  domain: "health" | "finance" | "calendar" | "work";
  unit: string;
  points: MetricPoint[];
  source: string;
  asOf: string;
  stale: boolean;
  downsampled?: boolean;
}

export interface KpiValue {
  metricId: string;
  label: string;
  value: number | null;
  unit: string;
  delta?: number;
  deltaPct?: number;
  trend?: "up" | "down" | "flat";
  asOf: string;
  stale: boolean;
  sourceConnected: boolean;
}

// ── Todos ─────────────────────────────────────────────────────────────────────

export interface TodoContract {
  id: string;
  text: string;
  due?: string;
  status: "open" | "done";
  source: "user" | "agent";
  createdAt: string;
  completedAt?: string;
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export interface AgendaEvent {
  id: string;
  summary: string;
  start: string; // ISO or HH:MM
  end: string;
  allDay: boolean;
  location?: string;
}

// ── Briefing ──────────────────────────────────────────────────────────────────

export interface BriefingContract {
  id: string;
  date: string;
  status: "generating" | "ready" | "error" | "empty";
  generatedBy: "llm" | "template";
  markdown: string;
  createdAt: string;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface MemoryContract {
  memoryId: string;
  text: string;
  kind: "episode" | "entity" | "fact";
  validFrom: number; // unix ms
  fusedScore: number;
}

// ── Profile (feature 20) ──────────────────────────────────────────────────────

export interface ProfileFactContract<T = string> {
  id: string;
  value: T;
  confidence: number;
  pinned: boolean;
  source: "derived" | "user";
  provenance?: string;
  updatedAt: string;
}

export interface PersonContract {
  name: string;
  relationship?: string;
  notes?: string;
}

export interface ProjectContract {
  name: string;
  status: "active" | "paused" | "done";
  description?: string;
}

export interface RoutineContract {
  description: string;
  cadence?: string;
}

export interface ProfileContract {
  preferences: ProfileFactContract[];
  people: ProfileFactContract<PersonContract>[];
  projects: ProfileFactContract<ProjectContract>[];
  routines: ProfileFactContract<RoutineContract>[];
  communicationStyle: ProfileFactContract[];
  proceduralBlock: string;
  version: number;
  updatedAt: string;
}

// ── Connectors (feature 9) ────────────────────────────────────────────────────

export interface SyncRunContract {
  id: string;
  source: string;
  status: "running" | "ok" | "partial" | "error";
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  pointsWritten: number;
  error?: string;
}

export type ConnectorTokenState =
  | "connected"
  | "expired_refreshable"
  | "expired_reconsent"
  | "not_connected"
  | "n/a";

export interface ConnectorStatusContract {
  id: string;
  label: string;
  desc: string;
  auth: "oauth" | "pat" | "push" | "token";
  scheduleLabel: string;
  token: ConnectorTokenState;
  tokenExpiresInMin?: number;
  /** Whether POST /api/connectors/sync can run this source on demand. */
  syncable: boolean;
  /** CLI command to (re)connect the source, shown when not connected. */
  connectCmd?: string;
  lastSync: SyncRunContract | null;
  recentRuns: SyncRunContract[];
  /** Latest data timestamp for sources without sync runs (push / finance). */
  lastDataAt?: string;
}

export interface SyncNowResult {
  source: string;
  ok: boolean;
  output: string;
}

// ── Finance (feature 11) ──────────────────────────────────────────────────────

export interface AccountContract {
  id: string;
  name: string;
  institution: string;
  type: "checking" | "savings" | "credit" | "investment" | "loan" | "cash" | "other";
  currency: string;
  isAsset: boolean;
  balanceMinor: number | null;
  balanceAsOf: string | null;
  lastSyncedAt: string;
  status: "active" | "disconnected" | "reauth_required";
}

export interface TransactionContract {
  id: string;
  accountName: string;
  amountMinor: number;
  currency: string;
  description: string;
  date: string; // posted (pending fallback) ISO
  status: "pending" | "posted";
  categoryId: string;
  categoryName: string;
  categoryColor: string;
}

export interface CategorySpendContract {
  categoryId: string;
  name: string;
  color: string;
  amountMinor: number;
}

export interface CashflowMonthContract {
  month: string; // YYYY-MM
  incomeMinor: number;
  expensesMinor: number;
}

export interface FinanceOverviewContract {
  netWorth: Array<{ currency: string; amountMinor: number }>;
  accounts: AccountContract[];
  spending30d: CategorySpendContract[];
  cashflow: CashflowMonthContract[];
}

// ── Calendar free time (feature 12) ───────────────────────────────────────────

export interface FreeSlotContract {
  start: string; // ISO
  end: string;   // ISO
  durationMin: number;
}

// ── Live status (SSE) ─────────────────────────────────────────────────────────

export interface LiveStatus {
  kind: "model" | "voice" | "approval" | "consolidation";
  model?: { id: string; loaded: boolean; vramMb: number; tps?: number };
  voice?: { listening: boolean; speaking: boolean };
  approvalCount?: number;
  consolidation?: { phase: string; pct: number };
}
