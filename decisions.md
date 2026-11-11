# Decisions

## Fairness and bias measurement — 2026-11-10

- Add an always-on deterministic name-invariance check at the real khata settlement handler and
  keep the overpayment decision helper's input limited to balance, amount, and confirmation state.
- Use a frozen synthetic corpus with 24 name strings, five transaction/stock intents, English,
  Hindi and Hinglish prompts, and three repeats. No name-to-community labels are stored. The
  translated prompts are `human_reviewed: false` until a native speaker reviews them.
- Report name-swap share with a Wilson interval and language differences with Newcombe intervals.
  Release thresholds are 100% observed name invariance, at least 80% observed success for every
  language, and no language more than 20 percentage points below English. These small repeated
  synthetic samples are descriptive, not population estimates.
- Live runs require `FAIRNESS_BUDGET_USD`, print the worst-case estimate before calls, and create
  an owned disposable database only on loopback. The release command fails on missing, stale,
  wrong-hash, malformed, or threshold-failing results. CI runs deterministic checks but not paid
  model calls.
- The runtime does not currently expose a declared language for text or Whisper transcripts.
  Do not add a detector just to populate counters; report this measurement gap and use no
  inferred demographic or language labels.
- Failure behavior: payment and billing decisions remain in Postgres and are not gated by the
  graph/evaluation tooling. Eval failures stop the eval or fail release; they do not change shop
  data. No fairness claim is made. The committed live report is NOT RUN.
# Architecture decisions

## Neo4j graph projection

**Decision (2026-11-10):** Postgres remains the source of truth. A transactional outbox projects business events and agent-action provenance into Neo4j. All money and stock rules remain in Postgres. The projector runs in the existing one-replica bot process; graph reads are owner-only and read-only at the application level.

**Failure behavior:** Neo4j connection/setup/query failures degrade graph health and graph tools, but do not block billing, stock, khata, or agent turns. Unacknowledged outbox events remain eligible for retry. Do not log credentials, event payloads, customer details, or freeform notes.

**Access:** Each graph node carries `storeId`; read queries scope all matched nodes to the authenticated store. Cypher uses fixed query templates and bound parameters. Community Edition has no roles and its users have implied administrator access, so reads use READ-mode sessions in separate application code paths; this is not a server-enforced read-only account.

**Operations:** Neo4j is an additional cost and operational burden for this one-store app. No production value or performance gain is claimed before deployment and measurement. See [deployment preparation](docs/neo4j-deploy.md) for cost assumptions, memory guidance, failure behavior, and rollback.
