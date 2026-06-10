/**
 * Canonical finance types (feature 11) — integer minor units (cents)
 * everywhere, ISO dates, no floats in storage or arithmetic.
 */

export interface Account {
  id: string; // internal stable id
  sourceId: string; // id from SimpleFIN/Actual
  connectorId: string; // feature 9 connector instance
  name: string;
  institution: string; // masked for display
  type: "checking" | "savings" | "credit" | "investment" | "loan" | "cash" | "other";
  currency: string; // ISO 4217
  isAsset: boolean; // false for credit/loan
  lastSyncedAt: string; // ISO
  status: "active" | "disconnected" | "reauth_required";
}

export interface AccountBalance {
  accountId: string;
  amountMinor: number; // integer cents, signed
  currency: string;
  asOf: string; // ISO (source balance-date)
  capturedAt: string;
}

export interface Transaction {
  id: string; // internal
  sourceTxnId: string | null;
  accountId: string;
  amountMinor: number; // negative = outflow, positive = inflow
  currency: string;
  description: string;
  postedAt: string | null; // ISO; null while pending
  pendingAt: string | null;
  status: "pending" | "posted";
  categoryId: string; // 'uncategorized' if unknown
  categorySource: "rule" | "user" | "ai" | "none";
  categoryConfidence?: number;
  dedupeHash: string;
}

export interface Category {
  id: string;
  name: string;
  group: "income" | "expense" | "transfer";
  parentId: string | null;
  color: string;
  isBuiltIn: boolean;
}

/** Serializable categorization rule: first keyword hit on the normalized
 * description wins. User rules sort before built-ins. */
export interface CategoryRule {
  id: string;
  categoryId: string;
  keywords: string[]; // lowercase substrings
  isUser: boolean;
}
