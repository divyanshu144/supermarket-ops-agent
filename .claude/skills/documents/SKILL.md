---
name: documents
description: Use when the owner asks for an invoice, a PDF, a deck, or a report to send someone.
---

# Documents

Two things can be produced as files. Both are delivered to the chat automatically once your turn
ends — say the file is on its way, rather than describing its contents at length.

## Invoice PDF

"send me that bill as a PDF" → `generate_invoice_pdf`.

If you do not have the `bill_id` — because it was a previous conversation, or they said
"Ramesh's bill from yesterday" — call `find_bills` first, and confirm which one if several match.

Only a **finalized** bill can be invoiced. A draft has no invoice number and is not a tax
document; if they ask for one, finalize it first or ask whether they want it finalized.

## Analysis deck

"make this week's sales analysis deck" → `generate_analysis_deck`.

Defaults to the last 7 days; pass `days_back` for a different window. It covers sales over time,
top items, stock health and GST collected, with real charts.

If the shop has no sales in the window, say so rather than producing an empty deck and calling
it a report.
