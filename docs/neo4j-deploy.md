# Neo4j deployment preparation

Status: preparation only. Nothing in this guide has been deployed. Pricing and limits checked 11 November 2026.

## Railway layout

1. Add a `neo4j:5-community` service to the existing Railway project and attach a persistent volume at `/data` (start with 5 GB; size from measured graph growth).
2. Put the service and bot in the same private Railway network. Do not add a public TCP proxy or public domain for Bolt. Set the bot's `NEO4J_URI` to the private service hostname and Bolt port.
3. Set Neo4j authentication on the service and configure `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, and `NEO4J_DATABASE` on the bot. Keep the password in Railway variables; do not put it in this repository or logs.
4. Set a 2 GB memory limit for the first production measurement. Neo4j memory is divided between JVM heap, page cache, native buffers, and the OS; the compose file's 1 GB limit is a local/test starting point, not a production sizing claim. Begin with explicit 512 MB heap and 512 MB page cache, then inspect actual memory use and Neo4j's memory recommendation before adjusting. Keep one bot replica because the bot uses long polling and runs one projector in-process.
5. Deploy only after confirming the existing Postgres backup and rollback procedures. On first boot, the worker installs graph constraints and drains the outbox. Existing Postgres rows require the backfill command before historical graph queries are complete.

The project does not contain a Railway Neo4j service definition because this repository must not create or modify the live Railway project. Railway currently bills service RAM at $10/GB-month, CPU at $20/vCPU-month, and volume storage at $0.15/GB-month. A continuously running estimate for 2 GB RAM, 0.5 vCPU, and 5 GB volume is about **$30.75/month** ($20 + $10 + $0.75), before egress and taxes. This is an estimate from published unit rates, not an invoice or a quote; plan credits may offset usage. Confirm the live calculator before provisioning. Railway documents private networking for service-to-service communication and supports per-service limits. [Railway pricing](https://docs.railway.com/pricing) · [Railway networking](https://docs.railway.com/guides/private-networking)

Neo4j's official memory guidance says to set heap and page-cache sizes explicitly and use `neo4j-admin server memory-recommendation` as an initial estimate. The 2 GB starting limit above is an engineering recommendation for a small always-on single-instance service, not a tested minimum or capacity guarantee. [Neo4j memory configuration](https://neo4j.com/docs/operations-manual/current/performance/memory-configuration/)

## Managed alternative

AuraDB Professional has a 1 GB minimum and is priced from $0.09/GB-hour. At 730 hours, that minimum is approximately **$65.70/month** (computed from the published hourly rate); storage, IO, backups, and data transfer are included in that tier. The 1 GB tier is sufficient to evaluate connectivity, but size the production instance based on graph size and observed query load. AuraDB Free is for development and learning, has graph-size limits, and does not provide production guarantees. AuraDB Professional is single-zone and has no SLA; the higher Business Critical tier advertises a 99.95% SLA and starts at a 2 GB minimum, with a listed rate from $0.20/GB-hour (about $292/month at 2 GB and 730 hours). It is likely disproportionate for this one-store app. [Neo4j pricing](https://neo4j.com/pricing/) · [Aura quotas and limits](https://neo4j.com/docs/aura/quotas-and-limits/)

Community Edition does not have role-based privileges: users have implied administrator access. This implementation therefore uses one Community account with separate code paths and Neo4j READ-mode sessions for tools, plus fixed parameterized Cypher and server-derived tenant scope. READ mode is an application-side safeguard, not a server-enforced credential boundary. If server-enforced read-only credentials are required, use an edition/tier with roles and provision distinct writer and reader users. [Neo4j user management](https://neo4j.com/docs/operations-manual/current/authentication-authorization/manage-users/) · [Neo4j edition differences](https://neo4j.com/docs/operations-manual/current/introduction/)

## Failure behavior and rollback

Postgres remains authoritative. Money and stock commit before graph projection, while each business transaction writes its outbox event atomically. If Neo4j is unavailable, source writes continue, outbox rows remain pending and retry, graph tools return `graph_unavailable`, and health reports degraded state. This protects write availability but means graph answers can lag or be unavailable.

To roll back the graph feature, remove the graph tools from tool registration and stop starting the projector in the bot release. Leave the additive `graph_outbox` table and its rows in Postgres: they do not affect business reads or writes, and preserve the projection backlog. Re-enable the projector later to replay idempotently. Do not drop the table while unprocessed rows exist. Removing the graph-tools registration hides graph answers immediately after the bot release; no Postgres rollback is needed.

## Cost and operational impact

Neo4j adds a persistent service, volume, credentials, backup/recovery work, monitoring, and a second datastore to a one-store system. It is extra operational complexity and has no measured production benefit yet. The graph is a read model and provenance aid; it does not replace existing Postgres tools. Running it continuously incurs the estimated cost above even if nobody asks graph questions. The owner should compare that cost with observed use after deployment.

## Verify before enabling historical queries

Run `pnpm graph:backfill` from the bot environment with `GRAPH_BACKFILL_STATE_FILE` set to a durable file path; the script projects one bounded page at a time and saves per-entity cursors after each successful event. Re-running it is safe. Then run `pnpm graph:reconcile <storeId>`; it reports bill, bill-item and movement counts plus per-product movement-delta sums, and exits nonzero on mismatch. Do not expose Neo4j publicly and do not run backfill against a production database until the operator deliberately starts it with the correct production environment.

The real schema does not store a `pendingActionId` on historical stock movements or khata entries. New confirmed-action writes carry that causal id in their outbox event, but a backfill cannot reconstruct missing links reliably; it projects only source facts and audit-to-action links that can be joined by the recorded confirmed update id.
