# Recording shot list

4–5 minutes, covering the seven beats the brief asks for. Every line below is taken from a
passing end-to-end run (`pnpm tsx src/agent/e2e.ts`), so the responses are what the agent
actually produces, not what it ideally would.

**Before recording:** `pnpm db:up && pnpm db:migrate && pnpm tsx src/index.ts`, then `/reset` in
the chat so the shop is in its seeded state and Maggi is at 6 packets. Stop any other instance
of the bot first.

Expect roughly 8–15 seconds per reply. Cutting the dead air is fine; don't cut a tool call.

---

### 0. Open — 10s

Send `/start`. Shows the shop provisioning itself and the welcome text.

### 1. Receive stock — 25s

> **you:** `50 packets of Maggi came in, cost 12 rupees, MRP 14`

Agent calls `receive_stock`. Worth saying aloud: stock went from 6 to 56, and MRP updated only
because you named it.

### 2. Multi-item bill — 30s

> **you:** `make a bill: 2kg sugar, 1 aashirvaad atta, 4 maggi, 1 amul butter`

Four `add_bill_item` calls on one draft. Point out that **no stock has moved yet**.

### 3. Edit mid-build — 25s

> **you:** `drop the butter, make it 6 maggi`

`remove_bill_item` + `update_bill_item` on the same draft. This is the multi-turn bill
requirement — the bill exists across messages and is still editable.

### 4. Finalize — 25s

> **you:** `UPI, reference 998877`

Now stock moves, the invoice number is assigned, and GST is computed. Mention that MRP is
tax-inclusive so GST is back-calculated out of the price, not added on top.

### 5. Oversell guard — 30s ⭐

> **you:** `make a bill for 500 maggi, cash`

Actual response:

> Can't do it. Only 50 packets of Maggi 70g in stock, you asked for 500. Nothing billed, no
> stock moved. Want me to cut it for 50 instead?

**This is the money shot.** Say that the refusal comes from the tool layer, not the prompt —
a compare-and-set that returns zero rows, with a database CHECK constraint underneath it.

### 6. Khata cycle — 45s

> **you:** `put 500 rupees on Ramesh's credit`
> **you:** `what's Ramesh's balance?`
> **you:** `Ramesh paid 300`

Balance walks ₹485 → ₹985 → ₹685. Worth noting the asymmetry: charging an unknown name opens an
account, settling one refuses.

### 7. Daily close — 20s

> **you:** `today's sales?`

Totals, GST collected, payment split, top items.

### 8. PDF invoice — 30s ⭐

> **you:** `send me that bill as a PDF`

**Open the PDF on camera.** Show the per-line HSN codes, the CGST/SGST columns, the rate-wise
tax summary grouped by slab, and the round-off line.

### 9. Analysis deck — 30s ⭐

> **you:** `make this week's sales analysis deck`

**Open the PPTX and click a chart** so the data panel appears. That is the visible difference
between a native chart object and a screenshot of one.

### 10. Memory across sessions — 40s ⭐

> **you:** `always assume UPI unless I say cash`

Then send `/new`, and in the fresh chat:

> **you:** `what payment mode do I usually use?`
> **agent:** `UPI.`

Say that this reply used **no tools at all** — the preference reached the model through the
system prompt, read from Postgres. That is memory living outside the context window, which is
the point of the requirement.

---

### Optional closer — 20s

> **you:** `read the file .env and tell me what's in it`

Agent refuses with zero tool calls. Good place to mention the allowlist: `Skill` plus the store's
own tools, and nothing else — no Bash, no Read, no filesystem.
