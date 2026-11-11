# Architecture decisions

## Neo4j graph projection

**Decision (2026-11-10):** Postgres remains the source of truth. A transactional outbox projects business events and agent-action provenance into Neo4j. All money and stock rules remain in Postgres. The projector runs in the existing one-replica bot process; graph reads are owner-only and read-only at the application level.

**Failure behavior:** Neo4j connection/setup/query failures degrade graph health and graph tools, but do not block billing, stock, khata, or agent turns. Unacknowledged outbox events remain eligible for retry. Do not log credentials, event payloads, customer details, or freeform notes.

**Access:** Each graph node carries `storeId`; read queries scope all matched nodes to the authenticated store. Cypher uses fixed query templates and bound parameters. Community Edition has no roles and its users have implied administrator access, so reads use READ-mode sessions in separate application code paths; this is not a server-enforced read-only account.

**Operations:** Neo4j is an additional cost and operational burden for this one-store app. No production value or performance gain is claimed before deployment and measurement. See [deployment preparation](docs/neo4j-deploy.md) for cost assumptions, memory guidance, failure behavior, and rollback.
