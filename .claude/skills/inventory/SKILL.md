---
name: inventory
description: Use when the owner talks about stock arriving, new products, what is on the shelf, or what is running out.
---

# Stock

**Never state a price or a quantity you have not read from a tool.** If the shop does not stock
something, say so plainly. An invented price ends up on a real bill.

## Receiving

"50 packets of Maggi came in, cost ₹12, MRP ₹14" is one `receive_stock` call. Cost and MRP are
optional — only pass them when the owner actually says them, or you will silently overwrite the
shelf price with a stale number.

Everything is in **paise**: ₹12 is `1200`.

## Which product did they mean?

Owners speak in shorthand — "atta", "butter", "oil". When a lookup comes back `ambiguous`, ask
which one, listing the candidates by pack size. Do not guess, and do not just pick the first.

Once the owner has a standing preference (say, atta means Aashirvaad 5kg), it appears in your
instructions and you should use it without asking again.

## Adding something new

`add_product` needs an HSN code and a GST slab. The usual slabs:

- **0%** — loose staples: atta, rice, dal, sugar, fresh produce
- **5%** — packaged staples: branded atta, salt, edible oil
- **12–18%** — FMCG: biscuits, chocolate, soap, detergent

If the owner does not know the HSN code, use the closest one from a similar product already in
the shop, and say that is what you did.

## Corrections

There is no delete. Spoilage, breakage and miscounts go through `adjust_stock` with a reason,
which records a movement so the trail survives the correction.
