# Deploying

The app is host-agnostic: one container, one long-poll process, one Postgres. It needs no
inbound port and no public URL, because Telegram long-polling is outbound-only. That makes the
hosting choice mostly a billing decision.

**Status: not currently deployed.** The Railway trial on this account has expired — both
`railway init` and `railway add --database postgres` refuse with *"Your trial has expired.
Please select a plan"*. Everything else is ready; see below for the exact steps on Railway or
any alternative.

---

## What the host must provide

| Requirement | Why |
|---|---|
| One always-on process | Long-polling holds an open `getUpdates` request. A host that sleeps on idle will drop messages. |
| **Exactly one replica** | Two processes polling one bot token produce `409 Conflict: terminated by other getUpdates request` and lose updates. This is not theoretical — it happened during development. |
| Postgres 16 | Schema uses partial unique indexes and check constraints. |
| Outbound HTTPS | To `api.telegram.org` and `api.anthropic.com`. No inbound needed. |

Environment variables: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`,
`AGENT_EFFORT` (default `medium`), `NODE_ENV=production`.

---

## Railway (configured, needs a plan)

`Dockerfile` and `railway.json` are committed. `railway.json` already pins
`numReplicas: 1` and `overlapSeconds: 0` — the second matters because a rolling deploy would
otherwise briefly run two containers and trip the 409.

```bash
railway login
railway init --name kirana-ops-agent
railway add --database postgres
railway variables set \
  TELEGRAM_BOT_TOKEN=... \
  ANTHROPIC_API_KEY=... \
  AGENT_EFFORT=medium \
  NODE_ENV=production
railway up

# Railway's Postgres starts EMPTY. The bot cannot serve a single message until this runs:
DATABASE_URL="$(railway variables get DATABASE_URL)" pnpm db:migrate
```

Then confirm one replica in the dashboard, message the bot, and check `railway logs | grep -i conflict` returns nothing.

## Fly.io (free allowance, needs a card)

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --name kirana-ops-agent   # detects the Dockerfile
fly scale count 1                                 # MUST be 1
fly postgres create --name kirana-db
fly postgres attach kirana-db                     # sets DATABASE_URL
fly secrets set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... AGENT_EFFORT=medium
fly deploy
fly ssh console -C "node -e \"1\""                # sanity
DATABASE_URL="$(fly ssh console -C 'printenv DATABASE_URL')" pnpm db:migrate
```

In `fly.toml`, remove any `[http_service]` block and set `auto_stop_machines = false` — the bot
has no inbound traffic to wake it, so autostop would silently kill the poller.

## Split: managed Postgres + any compute

Cheapest reliable combination if the above are awkward:

- **Neon** or **Supabase** for free Postgres → gives a `DATABASE_URL`
- **Koyeb**, **Fly**, or any small VPS for the container

The app does not care where Postgres lives. Point `DATABASE_URL` at it and run `pnpm db:migrate`
once from anywhere that can reach it.

## Local, for a demo

Works today and is what the end-to-end run uses:

```bash
pnpm db:up && pnpm db:migrate && pnpm tsx src/index.ts
```

Fine for a recorded walkthrough. **Not** adequate for the brief's "kept running while we
review" — a laptop cannot honestly promise multi-day uptime.

---

## After any deploy

1. **Stop every other instance first**, including a local `pnpm dev`. One token, one poller.
2. Run migrations — a fresh managed Postgres is empty.
3. Message the bot and check the logs for `409`.
4. Send `/start`, then `how much sugar is left?` — the reply must name a real quantity from the
   seeded catalogue, which proves the whole path.
