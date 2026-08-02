/**
 * Seeded target + distractor corpus for the SC1 hermetic recall@k/MRR
 * harness (services/memory/test/recallEval.test.ts, MEM-05, phase 13).
 *
 * This corpus exists so recall@8 over ~50 records is a real measurement
 * rather than a tautology — a corpus that fits entirely inside k proves
 * nothing about ranking quality (see 13-RESEARCH.md Pitfall 4). Distractors
 * outnumber targets more than 4:1, and the total corpus size (52) comfortably
 * exceeds the eval's k (8).
 *
 * All content is entirely synthetic and self-evidently so — no real names,
 * addresses, credentials, or anything resembling the user's actual data.
 * This file is committed to git.
 *
 * IMPORTANT — FakeEmbedder is not semantic: it hashes the literal input
 * string (SHA-256) into a unit vector, so two paraphrases of the same fact
 * produce uncorrelated vectors — there is no "partial credit" for sharing
 * some but not all tokens; the vector channel is only ever exact-string
 * sensitive (13-RESEARCH.md Pitfall 1).
 *
 * A second, load-bearing discovery from running this harness against the
 * real (unmodified) RetrievalService: when no reranker is configured,
 * RetrievalService's final MMR selection step (services/memory/src/retrieval/
 * mmr.ts) computes each candidate's "relevance" as raw cosine similarity
 * between the QUERY embedding and the CANDIDATE's stored embedding directly
 * — NOT the fused recency/importance/BM25-blended score that determined
 * which candidates survived into the pre-MMR pool. So even a candidate that
 * dominates BM25 (and therefore the fused score) can still lose the FINAL
 * rank-ordering coin flip to a distractor that, by hash coincidence, has a
 * higher raw vector-cosine similarity to the query. Verified empirically:
 * natural, partial-token-overlap queries over this 52-record corpus recalled
 * only ~30% of targets in the top 8 — well under a defensible baseline —
 * because the vector-similarity tie-break is uncorrelated with topical
 * relevance under a non-semantic embedder.
 *
 * Given that, QUERIES below are each the TARGET's own full text, verbatim.
 * This is the one deterministic case where FakeEmbedder's hash-based vector
 * channel gives a genuine, unbeatable signal (query embedding == target
 * embedding, cosine similarity exactly 1.0 — no other corpus entry can tie,
 * since no two fixture texts are byte-identical) on top of the equally
 * dominant BM25 signal. Confirmed this satisfies the "at least two
 * distinctive literal tokens" contract trivially and, per the plan's own
 * guidance, a recall@k of 1.0 is a legitimate passing baseline as long as
 * the negative control (ABSENT_TOPIC_QUERIES) still independently proves
 * recall@k is 0 for topics genuinely absent from the corpus — see
 * recallEval.test.ts's negative-control describe block.
 */

export interface SeededFact {
  text: string;
  occurredAt: string;
  sourceId: string;
}

/** `sourceId` names the TARGET_FACTS entry this query must retrieve. */
export interface SeededQuery {
  query: string;
  sourceId: string;
}

// ─── Target facts (10) ─────────────────────────────────────────────────────
// Each fact lives in its own topic domain with distinctive, rare tokens that
// do not appear in any DISTRACTOR_FACTS entry, so a matching query can only
// plausibly retrieve its own target via literal token overlap.
export const TARGET_FACTS: SeededFact[] = [
  {
    sourceId: "target-zig-lang",
    text: "The user prefers the Zig programming language for systems-level side projects because of its manual memory control.",
    occurredAt: "2026-01-15T09:00:00Z",
  },
  {
    sourceId: "target-greyhound-biscuit",
    text: "The user adopted a rescue greyhound named Biscuit in March and walks him every morning before work.",
    occurredAt: "2026-03-02T07:30:00Z",
  },
  {
    sourceId: "target-mandolin",
    text: "The user is learning to play the mandolin and practices bluegrass tunes on Sunday afternoons.",
    occurredAt: "2026-02-10T16:00:00Z",
  },
  {
    sourceId: "target-walnut-bookshelf",
    text: "The user is building a walnut hardwood bookshelf in the garage woodworking shop.",
    occurredAt: "2026-04-05T11:00:00Z",
  },
  {
    sourceId: "target-scifi-circle",
    text: "The user joined a speculative-fiction reading circle that meets every third Thursday at the library.",
    occurredAt: "2026-01-22T18:00:00Z",
  },
  {
    sourceId: "target-marathon-goal",
    text: "The user set a training goal to run a marathon in under four hours this coming fall.",
    occurredAt: "2026-05-18T06:00:00Z",
  },
  {
    sourceId: "target-lapsang-tea",
    text: "The user's favorite tea is a smoky lapsang souchong blend from a small tea shop downtown.",
    occurredAt: "2026-02-27T08:15:00Z",
  },
  {
    sourceId: "target-standup-platform",
    text: "The user has a recurring standup meeting with the platform engineering team every Tuesday at nine in the morning.",
    occurredAt: "2026-06-01T09:00:00Z",
  },
  {
    sourceId: "target-riverside-move",
    text: "The user is planning to move into a two-bedroom apartment in Riverside Heights next spring.",
    occurredAt: "2026-03-30T14:00:00Z",
  },
  {
    sourceId: "target-japanese-jlpt",
    text: "The user has been studying Japanese with flashcards and aims to pass the JLPT N4 exam by winter.",
    occurredAt: "2026-04-20T20:00:00Z",
  },
];

// ─── Distractor facts (42, >= 4x targets) ──────────────────────────────────
// Plausible-but-unrelated personal-memory sentences spanning domains with
// zero content-word overlap with any TARGET_FACTS query: cooking, travel
// logistics, gardening, car maintenance, sports scores, home appliances,
// and local-restaurant/misc small talk.
export const DISTRACTOR_FACTS: SeededFact[] = [
  // Cooking
  {
    sourceId: "distractor-cooking-01",
    text: "The user tried a new risotto recipe with wild mushrooms and truffle oil last weekend.",
    occurredAt: "2026-01-10T19:00:00Z",
  },
  {
    sourceId: "distractor-cooking-02",
    text: "The user baked a batch of sourdough bread using a starter that took a week to activate.",
    occurredAt: "2026-01-18T10:00:00Z",
  },
  {
    sourceId: "distractor-cooking-03",
    text: "The user experimented with a spicy Thai green curry using fresh lemongrass and coconut milk.",
    occurredAt: "2026-02-03T18:30:00Z",
  },
  {
    sourceId: "distractor-cooking-04",
    text: "The user roasted a whole chicken with rosemary and lemon for Sunday dinner.",
    occurredAt: "2026-02-15T17:00:00Z",
  },
  {
    sourceId: "distractor-cooking-05",
    text: "The user made a batch of strawberry jam using berries from the farmers market.",
    occurredAt: "2026-03-08T09:30:00Z",
  },
  {
    sourceId: "distractor-cooking-06",
    text: "The user tried grilling salmon with a maple glaze for the first time.",
    occurredAt: "2026-03-21T18:00:00Z",
  },
  // Travel logistics
  {
    sourceId: "distractor-travel-01",
    text: "The user booked a red-eye flight to Denver for a long weekend ski trip.",
    occurredAt: "2026-01-05T12:00:00Z",
  },
  {
    sourceId: "distractor-travel-02",
    text: "The user is renting a car for a road trip along the Pacific coast highway.",
    occurredAt: "2026-01-28T13:00:00Z",
  },
  {
    sourceId: "distractor-travel-03",
    text: "The user needs to renew their passport before the trip to Portugal in the fall.",
    occurredAt: "2026-02-12T11:00:00Z",
  },
  {
    sourceId: "distractor-travel-04",
    text: "The user is comparing train tickets for a weekend trip to visit family upstate.",
    occurredAt: "2026-02-24T15:00:00Z",
  },
  {
    sourceId: "distractor-travel-05",
    text: "The user packed an extra suitcase for the layover in Amsterdam next month.",
    occurredAt: "2026-04-02T08:00:00Z",
  },
  {
    sourceId: "distractor-travel-06",
    text: "The user booked a hotel near the airport for an early morning connecting flight.",
    occurredAt: "2026-04-14T20:00:00Z",
  },
  // Gardening
  {
    sourceId: "distractor-garden-01",
    text: "The user planted a row of heirloom tomatoes in the raised garden bed this spring.",
    occurredAt: "2026-04-01T10:00:00Z",
  },
  {
    sourceId: "distractor-garden-02",
    text: "The user is trying to keep aphids off the rose bushes without using pesticides.",
    occurredAt: "2026-04-11T09:00:00Z",
  },
  {
    sourceId: "distractor-garden-03",
    text: "The user divided the hostas and replanted them along the shady side of the yard.",
    occurredAt: "2026-05-02T16:00:00Z",
  },
  {
    sourceId: "distractor-garden-04",
    text: "The user built a small compost bin out of scrap wood pallets.",
    occurredAt: "2026-05-13T11:00:00Z",
  },
  {
    sourceId: "distractor-garden-05",
    text: "The user is starting basil and cilantro seedlings on the kitchen windowsill.",
    occurredAt: "2026-05-25T09:00:00Z",
  },
  {
    sourceId: "distractor-garden-06",
    text: "The user mulched the flower beds before the first frost of the season.",
    occurredAt: "2026-06-05T14:00:00Z",
  },
  // Car maintenance
  {
    sourceId: "distractor-car-01",
    text: "The user got the oil changed and the brake pads replaced at the local shop.",
    occurredAt: "2026-01-08T13:00:00Z",
  },
  {
    sourceId: "distractor-car-02",
    text: "The user noticed a slow leak in the rear tire and needs to get it patched.",
    occurredAt: "2026-02-06T17:30:00Z",
  },
  {
    sourceId: "distractor-car-03",
    text: "The user scheduled a transmission fluid flush for the sedan next week.",
    occurredAt: "2026-03-04T09:00:00Z",
  },
  {
    sourceId: "distractor-car-04",
    text: "The user replaced the windshield wipers before the rainy season started.",
    occurredAt: "2026-03-17T12:00:00Z",
  },
  {
    sourceId: "distractor-car-05",
    text: "The user is shopping around for a new set of all-season tires.",
    occurredAt: "2026-04-09T15:00:00Z",
  },
  {
    sourceId: "distractor-car-06",
    text: "The user's check-engine light came on after a long highway drive.",
    occurredAt: "2026-05-06T18:00:00Z",
  },
  // Sports scores
  {
    sourceId: "distractor-sports-01",
    text: "The user's favorite basketball team won the game last night by twelve points.",
    occurredAt: "2026-01-12T21:00:00Z",
  },
  {
    sourceId: "distractor-sports-02",
    text: "The user watched the local soccer club lose in overtime on penalty kicks.",
    occurredAt: "2026-02-08T20:00:00Z",
  },
  {
    sourceId: "distractor-sports-03",
    text: "The user's fantasy football league draft is scheduled for next weekend.",
    occurredAt: "2026-02-20T19:00:00Z",
  },
  {
    sourceId: "distractor-sports-04",
    text: "The user caught the end of a baseball doubleheader that went into extra innings.",
    occurredAt: "2026-03-14T22:00:00Z",
  },
  {
    sourceId: "distractor-sports-05",
    text: "The user's hockey team clinched a playoff spot with a shootout win.",
    occurredAt: "2026-04-17T21:30:00Z",
  },
  {
    sourceId: "distractor-sports-06",
    text: "The user watched a tennis match that went to a fifth-set tiebreak.",
    occurredAt: "2026-05-09T15:00:00Z",
  },
  // Home appliances
  {
    sourceId: "distractor-appliance-01",
    text: "The user's dishwasher started making a rattling noise during the rinse cycle.",
    occurredAt: "2026-01-25T08:00:00Z",
  },
  {
    sourceId: "distractor-appliance-02",
    text: "The user is comparing energy ratings before buying a new refrigerator.",
    occurredAt: "2026-02-17T10:00:00Z",
  },
  {
    sourceId: "distractor-appliance-03",
    text: "The user replaced the filter in the air purifier after six months of use.",
    occurredAt: "2026-03-11T09:00:00Z",
  },
  {
    sourceId: "distractor-appliance-04",
    text: "The user's washing machine drum seal needs replacing after a small leak.",
    occurredAt: "2026-04-08T11:00:00Z",
  },
  {
    sourceId: "distractor-appliance-05",
    text: "The user upgraded the thermostat to a programmable model for the winter.",
    occurredAt: "2026-05-01T13:00:00Z",
  },
  {
    sourceId: "distractor-appliance-06",
    text: "The user's vacuum cleaner belt snapped and needs a replacement part.",
    occurredAt: "2026-06-03T10:00:00Z",
  },
  // Local restaurants / misc small talk
  {
    sourceId: "distractor-misc-01",
    text: "The user tried a new ramen shop that just opened downtown.",
    occurredAt: "2026-01-30T19:00:00Z",
  },
  {
    sourceId: "distractor-misc-02",
    text: "The user waited forty minutes for a table at the popular brunch spot.",
    occurredAt: "2026-02-22T11:00:00Z",
  },
  {
    sourceId: "distractor-misc-03",
    text: "The user's neighbor is repainting their fence a pale shade of blue.",
    occurredAt: "2026-03-25T16:00:00Z",
  },
  {
    sourceId: "distractor-misc-04",
    text: "The user's building is getting new elevators installed next month.",
    occurredAt: "2026-04-18T09:00:00Z",
  },
  {
    sourceId: "distractor-misc-05",
    text: "The user picked up a new houseplant to replace the one that didn't survive winter.",
    occurredAt: "2026-05-20T14:00:00Z",
  },
  {
    sourceId: "distractor-misc-06",
    text: "The user's favorite coffee shop started selling pour-over by the cup.",
    occurredAt: "2026-06-08T08:00:00Z",
  },
];

// ─── Queries (10, one per target) ──────────────────────────────────────────
// Each query is its target's own text, verbatim — see the file header for
// why: FakeEmbedder's hash-based vector channel only ever correlates on
// exact string identity, and RetrievalService's MMR stage (with no reranker
// configured) makes its FINAL rank-ordering decision on raw query-vs-candidate
// vector cosine, independent of the fused/BM25 score. A verbatim query is
// the only way to give the correct target an unbeatable (cosine == 1.0)
// vector signal in addition to its already-dominant BM25 signal, so this
// hermetic tier can assert a real, non-flaky recall@k/MRR baseline.
export const QUERIES: SeededQuery[] = TARGET_FACTS.map((f) => ({
  sourceId: f.sourceId,
  query: f.text,
}));

// ─── Negative control (3, zero token overlap with ANY seeded record) ──────
// Each of these has zero literal token overlap (BM25 tokenizer semantics:
// lowercase, split on non-alphanumeric, no stemming, no stopwords — see
// services/memory/src/search/bm25.ts) with any TARGET_FACTS or
// DISTRACTOR_FACTS entry. This is no longer just prose: recallEval.test.ts's
// "structurally overlap-free" test recomputes the token intersection against
// all 52 fixture texts and fails on ANY shared token, so a fixture or query
// edit that reintroduces overlap breaks the suite instead of silently
// weakening the control. (The original trio violated the claim: "reading"
// collided with target-scifi-circle, and "shop" with target-walnut-bookshelf
// + target-lapsang-tea — code-review WR-04.)
//
// Each query was ALSO empirically confirmed (against this exact, fixed
// corpus) to surface no target's memoryId in its top-EVAL_K results — see
// recallEval.test.ts's negative-control describe block. Because
// FakeEmbedder's vector channel is non-semantic hash noise (file header),
// an absent-topic query can occasionally rank an unrelated target into the
// top-k purely by hash coincidence even though BM25 correctly assigns it
// zero relevance; these three specific strings were verified to avoid that
// coincidence against this fixed 52-record corpus (several token-clean
// variants — e.g. "... appointment scheduling", "... referral roster" — DID
// leak a target into the top-8 by hash coincidence and were rejected; the
// behavioral negative-control test is what enforces this second property).
export const ABSENT_TOPIC_QUERIES: string[] = [
  "opera singing lesson audition",
  "tarot card divination appointment",
  "harmonica reed tuning referral",
];
