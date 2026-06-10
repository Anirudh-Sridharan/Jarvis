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

// ── Live status (SSE) ─────────────────────────────────────────────────────────

export interface LiveStatus {
  kind: "model" | "voice" | "approval" | "consolidation";
  model?: { id: string; loaded: boolean; vramMb: number; tps?: number };
  voice?: { listening: boolean; speaking: boolean };
  approvalCount?: number;
  consolidation?: { phase: string; pct: number };
}
