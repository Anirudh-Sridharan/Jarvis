/**
 * Categorization (feature 11): deterministic rule engine, first match wins,
 * user rules sorted before built-ins. AI fallback is accepted per the spec
 * signature but is opt-in, bounded to metadata, and never overrides a rule
 * match; failures and low confidence leave `uncategorized` — never guess.
 */

import type { Category, CategoryRule, Transaction } from "./types.js";

export const UNCATEGORIZED = "uncategorized";

export const BUILT_IN_CATEGORIES: Category[] = [
  { id: "income", name: "Income", group: "income", parentId: null, color: "#27e2a4", isBuiltIn: true },
  { id: "groceries", name: "Groceries", group: "expense", parentId: null, color: "#41b0ff", isBuiltIn: true },
  { id: "dining", name: "Dining", group: "expense", parentId: null, color: "#7aa7ff", isBuiltIn: true },
  { id: "transport", name: "Transport", group: "expense", parentId: null, color: "#5ad0e6", isBuiltIn: true },
  { id: "utilities", name: "Utilities", group: "expense", parentId: null, color: "#9aa7ff", isBuiltIn: true },
  { id: "subscriptions", name: "Subscriptions", group: "expense", parentId: null, color: "#c08dff", isBuiltIn: true },
  { id: "transfer", name: "Transfer", group: "transfer", parentId: null, color: "#8899aa", isBuiltIn: true },
  { id: UNCATEGORIZED, name: "Uncategorized", group: "expense", parentId: null, color: "#667788", isBuiltIn: true },
];

export const BUILT_IN_RULES: CategoryRule[] = [
  { id: "r-payroll", categoryId: "income", keywords: ["payroll", "direct deposit", "salary"], isUser: false },
  { id: "r-groceries", categoryId: "groceries", keywords: ["whole foods", "trader joe", "safeway", "grocery"], isUser: false },
  { id: "r-dining", categoryId: "dining", keywords: ["doordash", "ubereats", "restaurant", "coffee", "cafe"], isUser: false },
  { id: "r-transport", categoryId: "transport", keywords: ["uber", "lyft", "shell", "chevron", "clipper"], isUser: false },
  { id: "r-utilities", categoryId: "utilities", keywords: ["pg&e", "comcast", "xfinity", "verizon", "at&t"], isUser: false },
  { id: "r-subs", categoryId: "subscriptions", keywords: ["netflix", "spotify", "icloud", "github", "openai", "anthropic"], isUser: false },
  { id: "r-transfer", categoryId: "transfer", keywords: ["transfer", "zelle", "venmo cashout", "payment thank you"], isUser: false },
];

function ruleMatches(rule: CategoryRule, txn: Transaction): boolean {
  const d = txn.description.toLowerCase();
  return rule.keywords.some((k) => d.includes(k));
}

export interface AiFallback {
  enabled: boolean;
  threshold: number;
  classify(p: {
    description: string;
    amountMinor: number;
    categories: string[];
  }): Promise<{ categoryId: string; confidence: number }>;
}

export async function categorize(
  txn: Transaction,
  rules: CategoryRule[],
  ai?: AiFallback,
  categories?: Category[],
): Promise<Transaction> {
  // 1. Deterministic rules — user rules first, first match wins.
  const ordered = [...rules].sort((a, b) => Number(b.isUser) - Number(a.isUser));
  for (const r of ordered) {
    if (ruleMatches(r, txn)) {
      return { ...txn, categoryId: r.categoryId, categorySource: r.isUser ? "user" : "rule" };
    }
  }
  // 2. Optional AI fallback — only metadata exposed, never on rule matches.
  if (ai?.enabled && categories) {
    try {
      const res = await ai.classify({
        description: txn.description,
        amountMinor: txn.amountMinor,
        categories: categories.map((c) => c.name),
      });
      if (res.confidence >= ai.threshold) {
        return {
          ...txn,
          categoryId: res.categoryId,
          categorySource: "ai",
          categoryConfidence: res.confidence,
        };
      }
    } catch {
      // AI failure → safe default below
    }
  }
  return { ...txn, categoryId: UNCATEGORIZED, categorySource: "none" };
}
