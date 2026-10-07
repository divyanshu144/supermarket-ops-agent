# Eval oracle amendment plan

> Status: approved by the user on 2026-10-07. This extends the approved Phase 1 plan after
> Task 3 review.

**Spec:** [Eval oracle amendment](../specs/2026-10-07-eval-oracle-amendment.md).

## Work sequence

1. Confirm package `pdfjs-dist@6.3.289` metadata, pinned version and Node engine. Installed as
   an exact dev dependency after approval. Verified Node 24.13.0 import of the official legacy
   entry point; now verify `getDocument`/`getTextContent` against a generated invoice.
2. Add PDF text extraction to the eval oracle with resource cleanup and bounded input size.
   Assert actual file text contains expected store/customer/product/invoice-total terms. Add a
   negative test where caller evidence claims the term but the file does not contain it.
3. Exercise the existing deck generator with a real chart-bearing fixture. Parse native chart
   XML and slide text from the generated PPTX. Fail closed if the generator emits no chart or
   expected text. Do not hand-author a fake “passing” production artifact.
4. Assert persisted line inputs (`qtyBase`, unit price, GST rate, product unit) and persisted bill
   aggregates against fixture constants. The schema has no persisted line total/tax columns. Do
   not add them here. Independently recompute each line result from DB inputs and compare it with
   the scenario's explicit line constants; document that line results are computed on read.
5. Reject owner and sentinel reference collisions. Tie external-change grounding checks to the
   exact changed entity and verify the returned value matches current snapshot state.
6. Add and mutation-check missing guards for schema references, store binding, account/ledger/
   preference comparisons, relevant snapshot columns, artifact contents, and grounding. Record
   each mutant and restored output in `evals/results/task-3-mutations.md`.
7. Run Task 3 focused tests against the dedicated disposable database, format/lint/typecheck,
   then the full gate. Obtain a fresh independent review before Task 4 consumes these APIs.

## Final review follow-up (2026-10-07)

The fake snapshot client now includes a foreign stock-movement row, and separate mutations of the
primary-store and sentinel-store movement predicates both fail. The actual generated invoice PDF
extraction asserts store name and GSTIN. The full verification gate passed with both DB URL
variables explicitly set to the disposable `eval_control` service. See the amendment section in
the Task 3 report and the final review round in `evals/results/task-3-mutations.md` for exact
output and mutation evidence.

## Stop conditions

- If `pdfjs-dist@6.3.289` cannot load on Node 24.13.0, stop and return a new proposal.
- If invoice/deck generation does not produce parseable expected contents, report that product
  gap instead of weakening the oracle.
- If no artifact library/source can support native chart assertions from a real deck, stop and
  return a separate plan amendment before claiming chart validation.
- Do not run paid model probes or live evals under this amendment.
