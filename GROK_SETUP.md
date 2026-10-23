# Setup guide for an AI agent (Grok)

If you are a Grok bot asked to set up or run this trading team, read this file first, then `bots/MARKET.md` and `bots/STRATEGY.md`.

## What this repo is

A six-agent trading desk for the Cauldron DEX (Bitcoin Cash). It runs entirely on Cloudflare:

| Piece | Where |
|---|---|
| Agent roles (your prompts) | `bots/*/ROLE.md`, shared rules in `bots/SHARED.md`, market notes in `bots/MARKET.md` |
| Owner's strategy (the only human input) | `bots/STRATEGY.md` |
| Team graph | `graph/team.yaml` |
| 15-minute trading loop | `src/loop.ts` (Cloudflare Worker cron) |
| Hard risk limits | `src/config.ts` → `RISK` (code, not prompts) |
| Database | Cloudflare D1, schema in `migrations/` |
| Trading desk website | `public/` served by the same Worker |
| Auto-deploy on every push | `.github/workflows/deploy.yml` |

The team self-improves: a 30-day scorecard by horizon and signal type is fed to the agents every cycle, losing horizons get smaller bets automatically, and Zara's daily lessons feed back into Vela and Nova.

Each cycle: Orin scans → Vela researches (with X and web search) and proposes → Kade's risk engine and veto → Nova approves → Rune executes → everything is logged. Zara writes a daily journal and lessons.

**Mode is PAPER.** Fills are simulated against live Cauldron quotes. Live trading with real keys is deliberately not built yet; it needs the owner's explicit approval.

## One-time setup

You need a Cloudflare account and an xAI API key. Run these from the repo root:

```bash
npm ci
npx wrangler login                      # or set CLOUDFLARE_API_TOKEN
npx wrangler d1 create trading-desk     # copy the database_id it prints
# put that id in wrangler.toml under [[d1_databases]] database_id
npm run db:migrate                      # creates the tables
npx wrangler secret put XAI_API_KEY     # the xAI key
npx wrangler secret put ADMIN_TOKEN     # any long random string; owner controls
npm run deploy                          # prints the desk URL
```

Then start the first cycle without waiting for the cron:

```bash
curl -X POST "$DESK_URL/api/admin/run" -H "authorization: Bearer $ADMIN_TOKEN"
```

Open `$DESK_URL` in a browser. The team runs every 15 minutes from then on.

## Auto-deploy from GitHub

In the GitHub repo settings, add:

- **Secrets:** `CLOUDFLARE_API_TOKEN` (with Workers and D1 edit rights), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `ADMIN_TOKEN`
- **Variables:** `DEPLOY_ENABLED` = `true`, `DESK_URL` = the Worker URL

After that, every push to `main` is typechecked, tested, migrated, deployed, and announced to the desk. The team sees the update in the activity log, and Nova sees it in her next decision.

## Changing how the team trades

- **Strategy** (allocation, style, appetite): edit `bots/STRATEGY.md` and push.
- **An agent's behaviour**: edit `bots/<agent>/ROLE.md` and push.
- **Hard limits** (position size, minimum liquidity, loss halt): edit `RISK` in `src/config.ts`, run `npm test`, and push.

## Owner controls

```bash
# halt buying (exits still run)
curl -X POST "$DESK_URL/api/admin/halt" -H "authorization: Bearer $ADMIN_TOKEN" -d '{"halted":true}'
# resume
curl -X POST "$DESK_URL/api/admin/halt" -H "authorization: Bearer $ADMIN_TOKEN" -d '{"halted":false}'
# reject a lesson Zara learned
curl -X POST "$DESK_URL/api/admin/lesson" -H "authorization: Bearer $ADMIN_TOKEN" -d '{"id":3,"status":"rejected"}'
```

## Read API (no auth; used by the website and the Apple app)

`GET /api/state`, `/api/events?after=<id>&limit=`, `/api/snapshots?days=N`, `/api/trades`, `/api/positions`, `/api/journal`, `/api/lessons`. All data lives in D1 and can also be queried directly:

```bash
npx wrangler d1 execute trading-desk --remote --command "SELECT * FROM trades ORDER BY id DESC LIMIT 20"
```

## Rules for any agent working on this repo

- Never commit secrets, private keys, or seed phrases. Keys are never part of this repo.
- Never switch to live trading or add signing code without the owner's explicit approval.
- Never loosen `RISK` limits on your own; that's an owner decision.
- Run `npm run typecheck` and `npm test` before pushing.

## Local development

```bash
node test/mock/indexer.mjs &                         # fake Cauldron indexer
printf 'INDEXER_URL="http://127.0.0.1:8788/cauldron"\nADMIN_TOKEN="dev"\n' > .dev.vars
npm run db:migrate:local
npm run dev                                          # http://localhost:8787
curl localhost:8787/__scheduled                      # run one cycle
```
