# Deploying

One container, one long-poll process, one Postgres. No inbound port and no public URL — Telegram
long-polling is outbound-only — so the hosting choice is mostly a billing decision.

**Currently deployed on Railway** as [@divagentBot](https://t.me/divagentBot): project
`kirana-ops-agent`, service `bot`, one replica, managed Postgres attached.

---

## What the host must provide

| Requirement | Why |
|---|---|
| One always-on process | Long-polling holds an open `getUpdates` request. A host that sleeps on idle drops messages. |
| **Exactly one replica** | Two processes on one bot token produce `409 Conflict: terminated by other getUpdates request` and lose updates. |
| Postgres 16 | Schema uses partial unique indexes and check constraints. |
| Outbound HTTPS | `api.telegram.org`, `api.anthropic.com`, and `api.openai.com` if voice is enabled. |

## Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Must be a valid URL; the process exits at boot if malformed. |
| `TELEGRAM_BOT_TOKEN` | yes | |
| `ANTHROPIC_API_KEY` | yes | |
| `NODE_ENV` | set `production` | |
| `AGENT_EFFORT` | no, default `medium` | `low` \| `medium` \| `high`. |
| `OPENAI_API_KEY` | no | Voice transcription. Without it the bot runs normally and replies that voice isn't configured. |
| `LOG_MESSAGE_TEXT` | no | `true` \| `false`. Defaults off in production, on elsewhere. |

Every variable is validated at boot, so a missing or malformed value fails immediately with a
readable message rather than mid-conversation.

**Migrations apply themselves on startup.** A freshly provisioned managed Postgres arrives empty;
the first deploy here died on `relation "processed_updates" does not exist` before this was
added. No manual migration step is needed on any host.

---

## Railway

`Dockerfile` and `railway.json` are committed. `railway.json` pins `numReplicas: 1` and
`overlapSeconds: 0` — the second prevents a rolling deploy briefly running two containers.

### Deploying a change

**The service is not linked to a GitHub repo, so `git push` does not deploy.** Deploys are
uploads:

```bash
railway up --service bot
```

Two commands that look like deploys but ship nothing new:

- `railway redeploy` — re-runs the **existing image**, however stale it is.
- `git push origin main` — updates GitHub and runs CI only.

To enable push-to-deploy, link the repo once: **Railway → `bot` → Settings → Source → Connect
Repo**, branch `main`.

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

`DATABASE_URL` is injected when the Postgres service is attached.

> `railway variables` prints values in full. Anything it echoes lands in shell history.

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

- **Neon** or **Supabase** for Postgres → gives a `DATABASE_URL`
- **Koyeb**, **Fly**, or any small VPS for the container

The app does not care where Postgres lives. Point `DATABASE_URL` at it and boot the container.

## Local

```bash
pnpm db:up && pnpm dev
```

Stop the deployed instance first, or both poll the same token and neither works reliably. Fine
for a recorded walkthrough; not adequate for "kept running while we review".

---

## Verifying a deploy

1. **Stop every other instance**, including a local `pnpm dev`. One token, one poller.
2. Check the logs:

   ```bash
   railway logs --lines 20
   ```

   Expect `Applying migrations… / Migrations up to date. / Listening as @divagentBot`.

3. Confirm the running build is the one you just shipped:

   ```bash
   railway status --json | grep -i reason   # "deploy" = new build, "redeploy" = existing image
   ```

4. Send `/reset`, then `how much sugar is left?` — the reply must name a real quantity from the
   seeded catalogue, which exercises Telegram → agent → tool → Postgres → reply.

5. Check that a JSON turn line appeared in the logs, carrying `update_id`, `tools` and
   `duration_ms`. **A handled message with no such line means an old build is still serving** —
   the most reliable signal available, since it needs no guesswork about timing.

### A single 409 after deploy is normal

Each restart logs one `409 Conflict` with a stack trace as the outgoing container exits —
Telegram only rejects the old poller once the new one starts. It is self-clearing.

**A repeating 409 is not.** That means two live pollers: usually a local `pnpm dev` left running,
or replicas set above 1.
