# Neo4j graph projection plan

## Goal and verified model

Postgres remains authoritative. The projection uses only current schema rows: `stores`, `products`, `bills`, `bill_items`, `khata_accounts`, `khata_entries`, `stock_movements`, `pending_actions`, `audit_log`, and `sessions`. Graph nodes are `Store`, `Product`, `Bill`, `KhataAccount`, `KhataEntry`, `StockMovement`, `PendingAction`, and `AuditEvent`; each has `storeId` plus a stable source id. `Store` comes from `stores`; there is no independent Customer entity. Relationships encode `CONTAINS` with the bill-item snapshot fields, `OF`, `CAUSED_BY` where `stock_movements.bill_id` exists, `HAS_ENTRY`, `RECORDED_IN` when a confirmed action has a matching audit event, and tenant ownership. A missing source link stays missing; the projector must not infer causality.

## Outbox and projector

Add a `graph_outbox` table with UUID id, store id, event type, entity id, JSON payload, created/processed timestamps, attempt count and a bounded error category. Insert the row in the same transaction as bill, stock movement, khata entry, pending action confirmation and audit writes. Payloads carry schema-derived snapshots and stable ids, with no secrets, transcripts, phone numbers or freeform notes. Worker claims rows with `FOR UPDATE SKIP LOCKED`, commits the claim, applies a parameterized idempotent `MERGE` in Neo4j, then marks the row processed in Postgres only after Neo4j confirms. A crash after graph commit replays safely. Failures retain rows and retry with bounded backoff; billing paths never await Neo4j.

## Failure and security boundaries

Neo4j connection/schema setup at boot is best-effort: connection failure leaves the app running degraded. The worker continues retrying. The health response reports Postgres separately and graph degraded state, pending lag and recent failures. Projection errors log event id/category without payload or credentials. Community Neo4j has one configured account, so use READ access-mode sessions and a separate graph-reader module; no credentials are logged. Every read tool receives the verified store id from server context and includes `storeId = $storeId` in every Cypher query. All values are parameters, queries are constants, result sizes and transaction timeouts are bounded. Graph is never used for billing or stock decisions.

## Tools

Add owner-only read tools `explain_stock_change` and `frequently_bought_with`, with Zod input bounds, date/product resolution through Postgres as needed, per-store filtering, maximum rows and a strict timeout. Return a clear graph-unavailable result on connection/query failure. Add customer credit exposure only if it can be derived without copying phone/note PII; initial scope omits it.

## Backfill and reconciliation

Provide a resumable Postgres cursor backfill which emits/uses the same stable projections, plus a direct idempotent replay path. Reconcile compares Postgres and graph counts for bills, bill items, stock movements and per-product stock sums; report differences and exit nonzero on any mismatch. Reconciliation is read-only.

## Runtime/deployment

Use the official Neo4j JavaScript driver. Add a private Docker Compose Neo4j service and a Neo4j test container profile for local/CI integration tests; no published database port by default. Boot applies constraints/indexes, starts one bounded projector loop in the existing single process, and closes driver/worker on shutdown. Railway configuration documents a private Neo4j service, persistent volume, memory, and environment variables; do not modify the live Railway project. `/health` reports degraded graph state. No default-off flag: the projector and graph tools are production architecture, with failures isolated from the source-of-truth path.

## Rollback

Set graph endpoints unavailable or remove the Neo4j service to stop projection; Postgres writes and the outbox remain valid and accumulate. Graph tools fail closed with an unavailable response. To disable code-level worker/tools without changing Postgres schema, deploy a rollback application version; the additive outbox table can remain unused. Re-enabling replays pending rows and reconciliation validates the projection. Never drop the outbox or graph data as part of rollback.

## Delivery sequence

1. Add mapping functions and tests for every event type; run full suite.
2. Add additive outbox schema, repository and transactional hooks; test atomicity and bill success without Neo4j; full suite.
3. Add Neo4j driver, constraints, idempotent projector, retry and lifecycle; integration tests for replay, crash, outage recovery; full suite.
4. Add read-only graph repository/tools, isolation/injection/limits tests; full suite.
5. Add backfill/reconcile CLI and real-container tests; full suite.
6. Add health/observability, Docker/CI/Railway prep, privacy-safe docs, update CLAUDE/HANDOFF/decisions; full gate, review, small commits and PR.

## Deployment cost and limits

No price is asserted in this plan because Railway resource prices and managed Neo4j limits vary by region, plan and date. `docs/neo4j-deploy.md` must cite the current calculator/pricing when finalized, estimate a small single-instance memory requirement from the chosen Neo4j image/config, identify storage/backup limits, and compare managed Neo4j read/write restrictions. Adding Neo4j increases operational work and recurring spend for a one-store application; deployer decides whether that tradeoff is worthwhile.
