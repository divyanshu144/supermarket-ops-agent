# Deploying

The app is host-agnostic: one container, one long-poll process, one Postgres. It needs no
inbound port and no public URL, because Telegram long-polling is outbound-only. That makes the
hosting choice mostly a billing decision.

**Status: deployed on Railway** as [@divagentBot](https://t.me/divagentBot) — project
`kirana-ops-agent`, service `bot`, one replica, with a managed Postgres attached.

---

## What the host must provide

| Requirement | Why |
|---|---|
| One always-on process | Long-polling holds an open `getUpdates` request. A host that sleeps on idle will drop messages. |
| **Exactly one replica** | Two processes polling one bot token produce `409 Conflict: terminated by other getUpdates request` and lose updates. Not theoretical — it happened during development, and again the first time a local `pnpm dev` overlapped the deployed instance. |
| Postgres 16 | Schema uses partial unique indexes and check constraints. |
| Outbound HTTPS | `api.telegram.org` and `api.anthropic.com`, plus `api.openai.com` if voice is enabled. No inbound needed. |

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Validated as a URL at boot; the process exits if malformed. |
| `TELEGRAM_BOT_TOKEN` | yes | |
| `ANTHROPIC_API_KEY` | yes | |
| `NODE_ENV` | set to `production` | Also flips message-text logging off by default. |
| `AGENT_EFFORT` | no, default `medium` | `low` \| `medium` \| `high`. The latency lever. |
| `OPENAI_API_KEY` | no | Whisper, for voice notes. **Without it the bot runs normally** and replies that voice isn't configured; text is unaffected. |
| `LOG_MESSAGE_TEXT` | no | `true` \| `false`. Defaults to off in production, on elsewhere. Inbound text carries customer names and amounts, so turning it on in production is a deliberate choice. |

Config is parsed and validated at import (`src/config/env.ts`), so a missing or malformed value
fails at boot with a readable message rather than mid-conversation.

**Migrations run automatically at boot** (`src/index.ts` → `runMigrations()`). A freshly
provisioned managed Postgres arrives empty, and the first Railway deploy died on
`relation "processed_updates" does not exist` before this was added. No manual migration step is
needed on any host.

---

## Railway (current deployment)

`Dockerfile` and `railway.json` are committed. `railway.json` pins `numReplicas: 1` and
`overlapSeconds: 0` — the second matters because a rolling deploy would otherwise briefly run two
containers and trip the 409.

### Deploying a change

**This service is not linked to a GitHub repo**, so `git push` does **not** deploy. Pushing
updates GitHub and runs CI; it does not touch Railway. Deploys are uploads:

```bash
railway up --service bot          # builds and deploys the working directory
```

Two commands that look like they deploy new code but do not:

- `railway redeploy` — re-runs the **existing image**. If the current image is stale, this
  redeploys the stale image, however many times you run it.
- `git push origin main` — CI only, unless the service is linked to the repo.

To get push-to-deploy, link it once: **Railway → `bot` → Settings → Source → Connect Repo**,
branch `main`. Worth doing — it removes the class of confusion above, and with CI green on `main`
the thing being deployed has already been verified.

### Checking what is actually running

```bash
railway logs --lines 20                      # expect: Applying migrations… / Listening as @…
railway status --json | grep -i reason       # "deploy" = new build, "redeploy" = old image
```

The most reliable signal is the structured turn log: every handled message emits one JSON line
with `update_id`, `store_id`, `tools` and `duration_ms`. **If you message the bot and no such
line appears, you are talking to an old build** — nothing else produces that silence, since the
pre-logging code only ever logged errors.

### First-time setup

```bash
railway login
railway init --name kirana-ops-agent
railway add --database postgres
railway variables --set TELEGRAM_BOT_TOKEN=... \
                  --set ANTHROPIC_API_KEY=... \
                  --set NODE_ENV=production
railway up --service bot
```

`DATABASE_URL` is injected by Railway when the Postgres service is attached. Migrations apply
themselves on the first boot.

> Beware `railway variables` printing secrets to your terminal — it echoes values in full, and
> anything echoed lands in shell history and any terminal-recording you happen to be making.

## Fly.io

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --name kirana-ops-agent   # detects the Dockerfile
fly scale count 1                                 # MUST be 1
fly postgres create --name kirana-db
fly postgres attach kirana-db                     # sets DATABASE_URL
fly secrets set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... NODE_ENV=production
fly deploy
```

In `fly.toml`, remove any `[http_service]` block and set `auto_stop_machines = false` — the bot
has no inbound traffic to wake it, so autostop would silently kill the poller.

## Split: managed Postgres + any compute

- **Neon** or **Supabase** for free Postgres → gives a `DATABASE_URL`
- **Koyeb**, **Fly**, or any small VPS for the container

The app does not care where Postgres lives. Point `DATABASE_URL` at it and boot the container.

## Local, for a demo

```bash
pnpm db:up && pnpm dev
```

**Stop the deployed instance first**, or both will poll the same token and neither will work
reliably. Fine for a recorded walkthrough; **not** adequate for the brief's "kept running while
we review" — a laptop cannot honestly promise multi-day uptime.

---

## After any deploy

1. **Stop every other instance first**, including a local `pnpm dev`. One token, one poller.
2. `railway logs --lines 20` — expect `Applying migrations… / Migrations up to date. /
   Listening as @divagentBot`.
3. Send `/reset`, then `how much sugar is left?` The reply must name a real quantity from the
   seeded catalogue, which proves the whole path: Telegram → agent → tool → Postgres → reply.
4. Confirm a turn log line appeared. That is the proof the new build is serving, not the old one.

### A 409 right after deploy is normal

Every restart logs one `409 Conflict` and a stack trace as the outgoing container dies: Telegram
only rejects the old poller once the new one starts, and grammY's polling loop cannot catch that
(`bot.catch` covers middleware, not `getUpdates`). It is expected and self-clearing.

**A 409 that keeps repeating is not** — that means two live pollers, usually a local `pnpm dev`
left running, or replicas set above 1.

## Rotating credentials

Both the bot token and the Anthropic key reached deployment logs before the error redactor
landed. The redactor stops new leaks; it does not scrub log history.

- **Telegram:** `/revoke` then `/token` with @BotFather, update `TELEGRAM_BOT_TOKEN`, redeploy.
  The `@handle` is unchanged, so the README link keeps working.
- **Anthropic:** issue a new key in the console, update the variable, redeploy, then revoke the old.
