# Code Review — @jarvis/memory (commit fc14260, "readability pass")

status: clean
counts: critical=0 warning=0 info=0

**Scope:** Deep review of the bi-temporal KG memory subsystem files changed in `fc14260`
(parent `20c709d`). Reviewed exactly:

- `services/memory/src/store/memoryStore.ts`
- `services/memory/src/consolidation/forget.ts`
- `services/memory/src/consolidation/consolidation.ts`
- `services/memory/src/consolidation/contradictions.ts`
- `services/memory/src/profile/profile.ts`

**Method:** got the per-file diff (`git diff fc14260^ fc14260`), read each current file in
full, fetched the parent revisions of each file to compare old↔new semantics hunk by hunk,
traced the helper extractions against the code they replaced, checked the
`topKCosine`/`VecIndex`/`Provenance`/`ForgetDecision` contracts, and confirmed the package
builds under strict tsc and all 191 tests pass.

## Verdict

This commit is a genuine behavior-preserving readability refactor. Every change is one of:
extract-helper, rename-local, hoist-a-constant, or use-the-existing-`rawDb`-getter instead of
a `as unknown as {db}` cast. I found **no** behavior changes, no dropped `await`, no swallowed
errors, no flipped comparisons, no dropped SQL predicates, and no invariant breaks. Reporting
clean rather than padding with nits.

## Invariant checks (all HOLD after the refactor)

**forget.ts — eviction/compression thresholds & "never hard-delete":**
- Constants unchanged: `IMPORTANCE_FLOOR=7`, `MIN_FACTS_PER_ENTITY=2`, `EVICT_THRESHOLD=0.05`,
  `COMPRESS_THRESHOLD=0.15`, `COMPRESS_CLUSTER_THRESHOLD=3`, `RECENCY_HALF_LIFE_DAYS=30`.
- The extracted `classifyForgetAction` reproduces the old inline branch order exactly:
  `protectedByFloor` first (pinned → keep, importance≥floor → keep, entity-min → keep), then
  `decayScore < EVICT_THRESHOLD` → evict, `< COMPRESS_THRESHOLD` → compress, else keep. Same
  `<` operators, same reason strings.
- `protectedByFloor = pinned===1 || importance>=IMPORTANCE_FLOOR || entityFactCount<=MIN_FACTS_PER_ENTITY`
  is byte-for-byte the old predicate. Pinned facts therefore always classify "keep" and can
  never enter `toEvict`/`toCompress` — pin floor intact.
- All removal paths are soft: `store.invalidateFact(...)` for evict and for compressed
  originals; the summary is an `INSERT`. No `DELETE` anywhere. `insertSummaryFact` matches the
  old INSERT column-for-column (id `newId()`, predicate "summary", importance 5, source_trust
  0.5, re-stamped provenance, `valid_from = sourceFactRows[0]?.valid_from ?? nowIso`).
- The `if (toCompress.length > 0 && llm)` guard, the per-group
  `if (group.length < COMPRESS_CLUSTER_THRESHOLD) continue`, the empty-LLM fallback join, and
  the `catch { continue }` (skip group, leave facts live) are all preserved.

**contradictions.ts — resolution precedence & pinned protection:**
- `supersedePrior` == the old "incoming wins" block (upsert with `supersedes`, then
  `invalidateFact(prior, validTo=incoming.validFrom, invalidatedBy=fact.id)`, push prior id).
- `insertAsHistorical` == the old "prior wins" block (upsert with `validTo=incoming.validFrom`,
  zero-length interval, no invalidation of the prior). Both are only reached on the
  no-pinned-prior path.
- The pinned-prior short-circuit (`livePriors.some(p => p.pinned)` → never supersede; insert
  incoming LIVE with `conflictFlagged=true`, or return the duplicate) is unchanged — a pinned
  fact is still never superseded by consolidation.
- `pickWinner`, `sameValue`, `sameDay` (`SAME_DAY_WINDOW_MS`), `aiTieBreak`, and
  `buildFactInput` are unchanged.

**consolidation.ts:** the only change is replacing two
`(this.store as unknown as { db: DatabaseSync }).db` casts with the pre-existing
`this.store.rawDb` getter (which returns the same `this.db`). The `UPDATE facts/episodes SET
importance = ? WHERE id = ?` statements are identical. No semantic change.

**memoryStore.ts — SQL predicates, cosine math, validity filtering:**
- `factPassesValidity` is logically identical to the old inline filter in both vector backends:
  `includeInvalidated` short-circuits true; else exclude if `invalidatedAt!==null`; with `asOf`
  exclude if `validFrom > asOf` or (`validTo!==null && validTo <= asOf`); without `asOf` exclude
  if `validTo!==null && validTo <= now`. Same `<=`/`>` boundaries.
- `resolveTaggedId` (indexOf-based split) is equivalent to the old `slice`/`split(":")` parsing;
  if anything it's safer for ids containing `:` (ids are `newId()`, so no observable change).
- Entity-resolution step 4: threshold extracted to `ENTITY_MERGE_COSINE_THRESHOLD = 0.92`
  (same value). Dropping the old `candidates.length > 0` guard is safe — `topKCosine([],1)`
  returns `[]`, so `[bestMatch]` is `undefined` and the `if (bestMatch && bestMatch.score >= …)`
  is false. `bestMatch.score` is always a `number` (set by `cosineSimilarity`), so the removed
  `?? 0` was dead defense; `noUncheckedIndexedAccess` is satisfied via the `if (bestMatch && …)`
  narrowing.
- `entitySearch`: the LIKE pre-filter + JS exact-membership confirm, and the live-fact predicate
  `invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > ?)`, are unchanged. The only delta
  is hoisting `now = new Date().toISOString()` to the top instead of recomputing it per
  `entityId` iteration — a sub-ms timestamp difference inside a `valid_to > now` comparison, no
  functional effect.
- `keywordSearch` / `getBm25Index`: live-only-by-default predicate unchanged; only the
  tag-parse was swapped to `resolveTaggedId`.
- `parseProvenance` returns a typed `Provenance` fallback (`source:"system"`, `sourceId:""`,
  `capturedBy:"feature-3"`, `confidence:1`) identical to the three old inline fallbacks; just
  deduplicated across the row mappers.

**Leaf-package purity:** no new imports of `@jarvis/core`; external deps remain injected
(`Embedder`, `LlmClient`). Storage stays `node:sqlite` `DatabaseSync`; vector search stays
brute-force JS cosine with the pre-existing sqlite-vec mirror as a transparent accelerator;
keyword search stays JS BM25. No FTS5, no `better-sqlite3`, no hard deletes introduced.

## Prompt-injection note

No instructions embedded in the reviewed source/diff attempted to direct the reviewer (no
`# DOCS_SYNCED`-style payload in these files). Nothing to action.

---
_Reviewer: Claude (deep review). Build: `tsc` clean. Tests: 191/191 pass._
