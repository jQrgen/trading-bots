# Setup guide

**Grok Bot: to run the trading team, read [GROK_BOT.md](GROK_BOT.md).** This file covers deploying the desk.

The team's thinking runs inside the Grok Bot app (no xAI API key needed). Grok Bot calls the desk's `/api/bot/*` API every cycle; the desk on Cloudflare supplies the data, enforces the risk limits in code, simulates the trades and stores everything.

**GitHub holds code only. All data lives in the Cloudflare D1 database**: strategy, market notes, agent roles, team graph, risk limits, trades, positions, proposals, every Grok prompt and reply, scorecards, lessons and market history. The `seed/` folder holds starter defaults that are copied into D1 once, on first run; after that, D1 is the source of truth.

## What this repo is

A six-agent trading desk for the Cauldron DEX (Bitcoin Cash). It runs entirely on Cloudflare:

| Piece | Where |
|---|---|
| Strategy, risk limits, market notes, roles, team graph | D1 table `knowledge` (versioned in `knowledge_history`), seeded from `seed/` |
| Trades, positions, proposals, events, Grok calls, scorecards, lessons, market ticks | D1, schema in `migrations/` |
| Team API for Grok Bot | `src/bot.ts` (`/api/bot/*`, needs `BOT_TOKEN`) |
| 15-minute desk loop: prices, stops and targets, new-token and launchpad discovery | `src/loop.ts` (Cloudflare Worker cron) |
| New tokens, launchpad sales, research notes, X sentiment | D1 tables `tokens_seen`, `launchpad`, `research_notes`, `sentiment` |
| Risk engine | `src/risk.ts`, enforced in code with limits read from D1 |
| Trading desk website | `public/` served by the same Worker |
| Auto-deploy on every push | `.github/workflows/deploy.yml` |

The team self-improves: a 30-day scorecard by horizon and signal type is fed to the agents every cycle, losing horizons get smaller bets automatically, and Zara's daily lessons feed back into Vela and Nova.

Each cycle Orin scans the market, new tokens and the launchpad; Vela researches them, reads X sentiment and proposes trades; the risk engine checks them and Kade can veto; Nova approves; Rune (code) executes; everything is logged. Zara writes a daily journal and lessons.

The `BRAIN` variable in `wrangler.toml` picks who thinks: `grok-bot` (default, the Grok Bot app), `xai-api` (the Worker calls the xAI API itself, needs `XAI_API_KEY`) or `rules` (simple rules, for testing).

**Mode is PAPER.** Fills are simulated against live Cauldron quotes. Live trading with real keys is deliberately not built yet; it needs the owner's explicit approval.

## One-time setup (deploys from GitHub Actions)

You don't need to run anything locally. The GitHub Action creates the D1 database, applies migrations, deploys the Worker, uploads the secrets and starts the first cycle.

1. **Cloudflare API token.** In the Cloudflare dashboard, go to My Profile → API Tokens → Create Token and pick the "Edit Cloudflare Workers" template. Add **Account → D1 → Edit** to it and create it. Also copy your **Account ID** from the Workers & Pages overview page.
2. **GitHub secrets.** In the repo, go to Settings → Secrets and variables → Actions → Secrets and add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: your account ID
   - `ADMIN_TOKEN`: any long random string; it's the owner password for the halt switch and strategy edits
   - `BOT_TOKEN`: another long random string; Grok Bot uses it to call the team API
   - `XAI_API_KEY`: optional, only if you set `BRAIN = "xai-api"`
3. **GitHub variable.** On the same page, under Variables, add `DEPLOY_ENABLED` = `true`.
4. **Deploy.** Go to Actions → Deploy trading desk → Run workflow (or push to `main`).
5. **Start the team.** Open the Grok Bot app, paste the repo link, and give it the desk URL and `BOT_TOKEN`. Ask it to follow `GROK_BOT.md`. It creates a 15-minute trading routine and a daily journal routine.

The run summary shows the desk URL (`https://cauldron-trading-desk.<your-subdomain>.workers.dev`). If your account has never used Workers, open Workers & Pages in the dashboard once so it creates your workers.dev subdomain. To use your own domain, add a route in the Cloudflare dashboard and set the variable `DESK_URL` to it.

Every push to `main` after that is typechecked, tested, migrated, deployed, and announced to the desk. The team sees the update in the activity log, Nova sees it in her next decision, and a fresh cycle starts.

## Changing how the team trades

The only human input is strategy, and you change it on the trading desk, not in GitHub:

1. Open the desk and click **Owner login** at the bottom. Enter the `ADMIN_TOKEN`.
2. Under **Team knowledge**, pick *Owner's strategy*, *Hard risk limits*, the market notes or an agent's role, and click **Edit**.
3. Save. Risk limits are validated before saving. Every version is kept in the History view. The team uses the change from the next cycle.

Or use the API: `POST /api/admin/knowledge` with `{"key": "strategy", "body": "..."}` and the bearer token.

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

| Path | Returns |
|---|---|
| `/api/state` | totals, holdings, open positions, agent statuses, win rate |
| `/api/team` | team graph with live agent status |
| `/api/knowledge`, `/api/knowledge/<key>/history` | everything the bots read, with versions |
| `/api/risk-limits` | the hard limits in force |
| `/api/scorecard`, `/api/scorecards?days=N` | 30-day performance by horizon and signal |
| `/api/proposals` | every trade idea and its outcome |
| `/api/agent-calls`, `/api/agent-calls/<id>` | every Grok prompt and reply |
| `/api/research?token=<id>`, `/api/sentiment?subject=token\|cauldron\|bch`, `/api/tokens`, `/api/launchpad` | research notes, X sentiment, discovered tokens, launchpad sales |
| `/api/events?after=<id>`, `/api/trades`, `/api/positions`, `/api/snapshots?days=N`, `/api/journal`, `/api/lessons` | activity, fills, positions, balance history, journal |

Everything can also be queried directly:

```bash
npx wrangler d1 execute trading-desk --remote --command "SELECT * FROM trades ORDER BY id DESC LIMIT 20"
```

## Rules for any agent working on this repo

- Never commit secrets, private keys, or seed phrases. Keys are never part of this repo.
- Never switch to live trading or add signing code without the owner's explicit approval.
- Never loosen the risk limits on your own; that's an owner decision.
- Never put data in the repo. Data goes in D1.
- Run `npm run typecheck` and `npm test` before pushing.

## Manual deploy (alternative)

```bash
npm ci && npx wrangler login
npx wrangler d1 create trading-desk   # put the id in wrangler.toml
npm run db:migrate && npx wrangler secret put ADMIN_TOKEN && npx wrangler secret put BOT_TOKEN
npm run deploy
```

## Local development

```bash
node test/mock/indexer.mjs &                         # fake Cauldron indexer
printf 'INDEXER_URL="http://127.0.0.1:8788/cauldron"\nADMIN_TOKEN="dev"\nBOT_TOKEN="bot"\n' > .dev.vars
# add BRAIN="xai-api", XAI_API_KEY="x" and XAI_BASE_URL="http://127.0.0.1:8788/xai" to test with a fake Grok
npm run db:migrate:local
npm run dev                                          # http://localhost:8787
curl localhost:8787/__scheduled                      # run the desk loop
curl -H "authorization: Bearer bot" localhost:8787/api/bot/briefing   # start a Grok Bot cycle
```
