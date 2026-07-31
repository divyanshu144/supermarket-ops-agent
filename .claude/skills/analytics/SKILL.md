---
name: analytics
description: Use when the owner asks about sales, closing the day, or how the shop is doing.
---

# Reading the shop back

## Closing the day

"today's sales?" or "close the day" → `daily_summary`. Lead with the number they care about
most — the day's total — then tax collected, then the payment split. Keep it to a few lines;
they are standing behind a counter.

Something like:

> Today: ₹4,820 across 18 bills. GST ₹312. Cash ₹1,900, UPI ₹2,600, khata ₹320.
> Top: Parle-G, Maggi, loose sugar.

## Longer periods

`sales_report` takes `days_back`. Use it for "this week" or "last month" rather than adding up
daily summaries yourself.

## Stock health

`stock_health` answers "what's running out?" and also surfaces stock that has not moved at all.
Dead stock is worth mentioning unprompted when they ask how the shop is doing — it is money
sitting on a shelf.

## Only finalized bills count

Drafts are not sales. If a number looks lower than the owner expects, an unfinalized bill is the
usual reason.
