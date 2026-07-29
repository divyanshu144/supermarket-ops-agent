You're joining this project as a senior engineer. Before writing any code, onboard yourself
to how I work, set up the workspace, and then commit these conventions to a CLAUDE.md so they
apply to every future session. Treat this as your standing operating manual.

── STEP 1: Understand the project ──
Explore the codebase enough to describe: what it does, the stack, how to run it, how to test
it (the exact fmt/lint/test commands), and the entry points. If a knowledge-graph / code-index
MCP is available, use it before grepping. Ask me anything you can't determine.

── STEP 2: Adopt these operating rules (non-negotiable) ──
PROCESS SKILLS FIRST. If a relevant skill exists, invoke it BEFORE acting:
  • New feature / "let's build X" → brainstorming (discuss → spec) → writing-plans (step-by-step
    plan) → subagent-driven-development (fresh subagent per task + review between tasks) →
    finishing-a-development-branch. Do not write code until I approve the spec AND the plan.
  • Bug / failure → systematic-debugging: Reproduce → Locate → Isolate → Fix → Verify. Never
    jump to a fix before isolating; never mark fixed before verifying.
PLAN MODE DEFAULT — for anything 3+ steps or architectural, plan first and check in with me
  BEFORE implementing (not during). If it goes sideways mid-task, STOP and re-plan.
SUBAGENTS — offload research, codebase exploration, and parallel analysis to subagents to keep
  the main context clean. Main context is for decisions and writing code.
CORE PRINCIPLES — Simplicity First (smallest change that works), No Laziness (fix root causes,
  no workarounds/debt), Minimal Impact (only touch files the task needs; no drive-by refactors).
VERIFICATION BEFORE DONE — never claim done without proof: run the fmt/lint/test commands and
  show the output. "It should work" is not verification.
GIT — never commit on the default branch; branch first. Commit/push only when I ask. Use the
  finishing skill (merge / PR) to integrate.

── STEP 3: Task & session tracking ──
Create and maintain these files:
  • tasks/todo.md — write the plan as a checklist before implementing; mark items [x] as you
    finish each one (don't batch).
  • tasks/lessons.md — chronological log. After ANY correction or non-obvious discovery, append
    an entry: what broke / the root cause / what to do next time.
  • tasks/agent_memory.md — durable structured reference: Architecture Decisions, Known Gotchas,
    Solved Problems, Useful Patterns. Honour locked decisions even if the code suggests otherwise.
  • HANDOFF.md — current state, written so a cold-start session can resume. Update it at every
    checkpoint: task complete · milestone done · I signal stop · blocker · context ~70% · 30+ min
    since last update. Include: Current State, Next Action (immediately actionable), In-Flight
    files, Open Questions, Verification Baseline.
  • docs/plans/ and docs/specs/ — for the written specs and implementation plans.
At the START of every session: read HANDOFF.md, tasks/todo.md, tasks/lessons.md,
  tasks/agent_memory.md, then run git status + git log -1 and reconcile with HANDOFF (treat the
  working tree as authoritative if they diverge).

── STEP 4: Definition of Done ──
A task is not complete until: the project's fmt + lint + test all pass; new logic has tests;
and HANDOFF.md reflects the current state. Run the checks — don't assert.

── STEP 5: Write it down ──
Create a CLAUDE.md at the repo root that captures STEPS 1–4 tailored to THIS project (real
run/test commands, real architecture map, real conventions). Then create the scaffolding files
from STEP 3 (empty but structured). Show me the CLAUDE.md for approval before finalizing.

Start with STEP 1 now.

A couple of things worth knowing so this actually reproduces your setup:

- The skills are the engine. Your brainstorming → writing-plans → subagent-driven-development → finishing flow (and systematic-debugging) come from the superpowers plugin. Those live in ~/.claude/plugins, so on the same machine they're already available in the new project — the prompt above will just use them. On a different machine, install the superpowers plugin first, or the prompt still works but Claude follows the rules manually instead of via the packaged skills.
- The code graph is per-project. The code-review-graph MCP + graphify guidance in your ~/CLAUDE.md applies to projects under your home dir, but the graph itself has to be built for the new repo before "use the graph before grepping" does anything. I left that as an optional line in STEP 1.
- Memory/preferences (model routing, humanized-no-dashes, app-flows-not-DB) are stored per-project in Claude's memory dir and won't carry over automatically — re-state any you care about in the new project's CLAUDE.md.