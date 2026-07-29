# HANDOFF

Written so a cold-start session can resume. Update at every checkpoint: task complete ·
milestone done · user signals stop · blocker · context ~70% · 30+ min since last update.

**Last updated:** 2026-07-29, end of design phase

---

## Current State

Design phase complete. **No implementation code exists yet** — no `package.json`, no `src/`.
The repo currently holds documents only.

- `Assignment.md` — the BigMantra brief (note: this file was *replaced* mid-session; the
  original Newpage RAG brief is gone. The kirana agent brief is the real one.)
- `claude_onboarding.md` — the operating manual this project was bootstrapped from
- `CLAUDE.md` — project operating manual, all stack decisions now locked
- `docs/specs/2026-07-29-supermarket-ops-agent-design.md` — **the design spec, awaiting approval**
- `tasks/todo.md`, `tasks/lessons.md`, `tasks/agent_memory.md` — tracking, seeded
- Git initialised on `main`. **Nothing committed yet.** No remote.

## Next Action

Spec has been through one review round; all eight findings applied (see `tasks/agent_memory.md`
AD-15 … AD-25). **Blocked on final go-ahead.** Once given:

1. Invoke `writing-plans` to turn the spec into a step-by-step implementation plan in
   `docs/plans/`.
2. Branch off `main` (never commit on `main` — CLAUDE.md §6).
3. Execute **Milestone 0 — the walking skeleton**: minimal schema, one tool, allowlist on,
   deployed to Railway, real Telegram message reaching Postgres. Plus the three §14
   verifications, of which **skill loading vs. the disabled `Read` tool is the highest risk** —
   it can invalidate the whole §9 layer and must be tested before four more skills get written.

If the user has already approved and this file is stale, check `tasks/todo.md` for the first
unchecked item.

## In-Flight Files

None. No edits in progress.

## Open Questions

None blocking. Deferred to implementation and recorded in spec §14:

- Exact synthetic sales-history distribution (data, not architecture)
- Invoice visual template (correctness first, styling if time allows)
- Whether `void_bill` ships (first thing cut if Milestone 4 is at risk)

## Verification Baseline

**No gate exists yet.** The toolchain is not scaffolded, so
`pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test` does not run. Do not cite it as
passing until Milestone 1 creates `package.json` and the configs. First real baseline will be
recorded here once Milestone 1 completes.

## Constraints Worth Re-reading

- **2 days, fixed deadline.** Scope is §3 capabilities + §4 hard parts. Zero §7 stretch items.
- Milestone 3 (end-to-end conversation) must complete on day one.
- The Claude Agent SDK is **not** covered by the `claude-api` skill — see
  `code.claude.com/docs/en/agent-sdk`.
