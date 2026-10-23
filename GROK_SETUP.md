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

## One-time setup (deploys from GitHub Actions)

You don't need to run anything locally. The GitHub Action creates the D1 database, applies migrations, deploys the Worker, uploads the secrets and starts the first cycle.

1. **Cloudflare API token.** In the Cloudflare dashboard, go to My Profile → API Tokens → Create Token and pick the "Edit Cloudflare Workers" template. Add **Account → D1 → Edit** to it and create it. Also copy your **Account ID** from the Workers & Pages overview page.
2. **GitHub secrets.** In the repo, go to Settings → Secrets and variables → Actions → Secrets and add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: your account ID
   - `XAI_API_KEY`: your xAI key for Grok
   - `ADMIN_TOKEN`: any long random string; it's the owner password for the halt switch
3. **GitHub variable.** On the same page, under Variables, add `DEPLOY_ENABLED` = `true`.
4. **Deploy.** Go to Actions → Deploy trading desk → Run workflow (or push to `main`).

The run summary shows the desk URL (`https://cauldron-trading-desk.<your-subdomain>.workers.dev`). If your account has never used Workers, open Workers & Pages in the dashboard once so it creates your workers.dev subdomain. To use your own domain, add a route in the Cloudflare dashboard and set the variable `DESK_URL` to it.

Every push to `main` after that is typechecked, tested, migrated, deployed, and announced to the desk. The team sees the update in the activity log, Nova sees it in her next decision, and a fresh cycle starts.

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

## Manual deploy (alternative)

```bash
npm ci && npx wrangler login
npx wrangler d1 create trading-desk   # put the id in wrangler.toml
npm run db:migrate && npx wrangler secret put XAI_API_KEY && npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

## Local development

```bash
node test/mock/indexer.mjs &                         # fake Cauldron indexer
printf 'INDEXER_URL="http://127.0.0.1:8788/cauldron"\nADMIN_TOKEN="dev"\n' > .dev.vars
npm run db:migrate:local
npm run dev                                          # http://localhost:8787
curl localhost:8787/__scheduled                      # run one cycle
```
