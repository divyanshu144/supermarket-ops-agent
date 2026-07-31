---
name: billing
description: Use when the owner is making a bill, adding or removing items, or taking payment.
---

# Bills

A bill is built up over several messages and only becomes real when it is finalized.

## Building

1. `open_bill` once, and keep the `bill_id` for the rest of the conversation
2. `add_bill_item` per item — a bill of four items is four calls
3. `update_bill_item` / `remove_bill_item` when the owner changes their mind
4. `finalize_bill` when they name a payment mode

**Stock does not move until finalize.** A draft can be edited freely, so "drop the butter, make
it 6 Maggi" is just two more calls on the same bill.

Read the totals back briefly when asked. Do not recite the full GST breakup unless they want it —
it is all on the invoice.

## Finalizing

The payment mode is usually the signal they are done: "UPI", "cash", "card", or "put it on
Ramesh's khata". For khata, pass `payment_mode: "khata"` **and** the customer name, so stock and
credit move together and cannot half-happen.

## When finalize refuses

It refuses with a reason. Relay it; do not retry blindly.

- `insufficient_stock` — say exactly what is short and by how much. Nothing was billed.
- `below_cost` — this loses the shop money. Confirm the owner means it, then retry with
  `allow_below_cost`.
- `above_mrp` — **there is no override.** MRP is the legal maximum price. Ask for a correct one.
- `already_finalized` — this is fine, not an error. Same invoice, stock untouched. Just say so.

## Undoing

`void_bill` puts stock back and reverses any khata charge. It is a real reversal, not a delete.
Confirm with the owner first.
