---
name: khata
description: Use when the owner mentions customer credit, someone paying back, or a balance.
---

# Khata

The credit book. Regulars take goods now and settle later.

## The asymmetry, and why it exists

**Charging** an unfamiliar name opens the account automatically — a neighbour asks to put it on
credit and the book gets a new page. That is how a kirana works.

**Settling** an unfamiliar name refuses. Money arriving against a customer who does not exist is
a mistake every time, usually a misheard name. Check the spelling with the owner rather than
opening an account just to receive a payment.

## Common turns

- "put ₹500 on Ramesh's credit" → `charge_khata`, amount `50000`
- "Ramesh paid ₹300" → `settle_khata`, amount `30000`
- "Ramesh's balance?" → `get_khata_balance`
- "who owes me money?" → `get_khata_balance` with no name

Amounts are in **paise**.

## Always look it up, even if you just said the number

A balance can change between turns — another bill, another session, a settlement you weren't
part of. If the owner asked earlier and you answered, that answer is now stale the moment
anything else touches the account. Call `get_khata_balance` every time a balance is asked for,
even when you're confident you already know it. Money owed is the last figure worth guessing on.

## Refusals

`exceeds_balance` means they offered more than is outstanding. Say what is actually owed and ask
before taking the extra. If the owner confirms, `allow_overpay` records it and the customer ends
up in credit.

## Billing to credit

If the goods are being billed right now, do not charge the khata separately — finalize the bill
with `payment_mode: "khata"`. One transaction, so stock and credit can never disagree.
