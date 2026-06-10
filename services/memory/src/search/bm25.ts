/**
 * Pure-JS BM25 implementation for keyword search over memory text.
 *
 * We implement BM25 from scratch to avoid depending on SQLite FTS5
 * (which may be absent in some Node builds). At single-user scale (thousands of
 * documents) this is fast enough.
 *
 * TODO(scale): switch to SQLite FTS5 bm25() when available, or a dedicated
 * search library, at corpus sizes >100k docs.
 */

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface BM25Doc {
  id: string;
  text: string;
}

export interface BM25Result {
  id: string;
  score: number;
}

/** Tokenize: lowercase, split on non-alpha, remove empty. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export class BM25Index {
  private docs: Map<string, string[]> = new Map(); // id -> tokens
  private df: Map<string, number> = new Map(); // term -> doc freq
  private avgDl = 0;
  private N = 0;

  addDocument(id: string, text: string): void {
    const tokens = tokenize(text);
    this.docs.set(id, tokens);
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  /** Rebuild aggregate stats — call after all documents are added. */
  build(): void {
    this.N = this.docs.size;
    if (this.N === 0) {
      this.avgDl = 0;
      return;
    }
    let totalLen = 0;
    for (const tokens of this.docs.values()) {
      totalLen += tokens.length;
    }
    this.avgDl = totalLen / this.N;
  }

  /**
   * Score all documents for the given query string. Returns top-K results
   * sorted by BM25 score descending.
   */
  search(query: string, k: number): BM25Result[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.N === 0) return [];

    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;

      // IDF with epsilon floor (Robertson IDF)
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);

      for (const [docId, tokens] of this.docs.entries()) {
        const tf = tokens.filter((t) => t === term).length;
        if (tf === 0) continue;

        const dl = tokens.length;
        const norm =
          tf *
          (BM25_K1 + 1) /
          (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(1, this.avgDl))));

        scores.set(docId, (scores.get(docId) ?? 0) + idf * norm);
      }
    }

    const results: BM25Result[] = Array.from(scores.entries()).map(
      ([id, score]) => ({ id, score }),
    );
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /** Remove a document from the index. */
  removeDocument(id: string): void {
    const tokens = this.docs.get(id);
    if (!tokens) return;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        const prev = this.df.get(t) ?? 0;
        if (prev <= 1) {
          this.df.delete(t);
        } else {
          this.df.set(t, prev - 1);
        }
      }
    }
    this.docs.delete(id);
    this.N = this.docs.size;
  }

  get docCount(): number {
    return this.N;
  }
}

/**
 * Build a fresh BM25Index from an array of documents.
 */
export function buildBM25Index(docs: BM25Doc[]): BM25Index {
  const index = new BM25Index();
  for (const doc of docs) {
    index.addDocument(doc.id, doc.text);
  }
  index.build();
  return index;
}
