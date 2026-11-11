# Approved implementation plan

Base: d2bbaf0. Branch: feat/semantic-cache-injection-evals.

1. Provision disposable, isolated PostgreSQL; run current-agent injection baseline.
2. Add bounded TTL semantic cache with real swappable embeddings and conservative eligibility.
3. Measure 120+ labelled queries at 0.85/0.90/0.95 including negatives and live data.
4. Harden data boundaries, argument checks, confirmation and output handling; repeat identical attacks.
5. Run formatting, lint, typecheck and isolated tests; publish raw evidence and honest tables.

No production configuration or store data changes. Existing security stays in the baseline.
No fabricated model metrics; provider errors are inconclusive. No large dependency without approval.
