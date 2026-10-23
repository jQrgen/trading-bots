# Cauldron Trading Desk: Project Plan

_Status: draft v0.1, 2026-10-23. Owner: Jørgen S. Notland._

## 1. Goal

Run a team of Grok-powered bots that research, plan and execute short-, medium- and long-term trades on the Cauldron DEX (Bitcoin Cash / CashTokens). Success is measured in one number: **total holdings valued in ParyonUSD (PUSD)**.

Core user story:

> As a human I want to be able to visit the trading desk website to be able to see what the bots are doing.

Everything a bot thinks, decides and does must therefore be logged and visible on the desk.

## 2. What we're trading on (research summary)

| Thing | Facts that matter for the bots |
|---|---|
| **Cauldron** (cauldron.quest) | AMM DEX on Bitcoin Cash. Every pool is a CashToken paired with BCH. About $1.1M TVL and $20k daily volume (DefiLlama, 2026-10-23). That's thin, so slippage and position size matter a lot. |
| **ParyonUSD (PUSD)** | BCH-collateralised stablecoin (Liquity V2 style, 110% min collateral, redeemable for BCH). Token category `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`. Its Cauldron pools hold about 451 BCH against about 128k PUSD, so PUSD↔BCH is the deepest route on the DEX. _"Parity USD" in the brief is assumed to mean this token; see open questions._ |
| **Cauldron Router API** | `wss://router.riften.net/v1/route`, JSON-RPC over WebSocket, beta, no auth, rate limited. `route.quote` / `route.subscribe` for prices, `tx.build` / `tx.subscribe` for **unsigned** swap transactions. 0.1% router fee as an on-chain output (must not be stripped). Docs: https://docs.riftenlabs.com/router/ |
| **Broadcast API** | `https://broadcast.cauldron.quest/broadcast`. The router never broadcasts; we POST the signed tx here (preferred over a single node to avoid double-spend conflicts on chained pool trades). |
| **Riften indexer** | `https://indexer.riften.net/cauldron/...`, REST/JSON, no auth. Token lists, current price, OHLC candles, volume, TVL, latest txs, first-pool date per token. This is the bots' market data feed. |
| **riftenlabs-cli** | Private GitLab repo (gitlab.com/dagurval/riftenlabs-cli2) with routing, Rostrum (Electrum server) client, built-in wallet and WizardConnect. Not required for trading per Dagur; useful later for wallet/signing and for sites with no API. |

Key implication: because everything is quoted against BCH, every trade is effectively _token ↔ BCH ↔ PUSD_. The "home" asset is PUSD; holding BCH is itself a directional bet.

## 3. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Trading Desk website           │
                    │  agents • balance chart • activity log   │
                    │  open positions • win rate • kill switch │
                    └───────────────▲──────────────────────────┘
                                    │ read-only API + SSE
┌────────────┐   ┌──────────────────┴─────────────────────┐   ┌──────────────┐
│ Riften     │──▶│              Desk Core                  │──▶│ Signer       │
│ indexer    │   │  scheduler • message bus • event store │   │ (isolated,   │
│ Router WS  │──▶│  portfolio ledger • risk engine         │   │  holds keys) │
└────────────┘   └──────────────────▲─────────────────────┘   └──────┬───────┘
                                    │ tool calls                       │ signed tx
                         ┌──────────┴──────────┐                       ▼
                         │  Bot team (Grok)    │             broadcast.cauldron.quest
                         └─────────────────────┘
```

Components:

1. **Market data service**: polls the indexer (token list, prices, candles, volume, TVL, latest txs) and keeps a live router subscription for watched pairs. Writes snapshots to the event store.
2. **Bot runtime**: runs each bot as a Grok (xAI API) agent with a role prompt, a skill set (tools) and a schedule. Bots never touch keys or the network directly; they call tools.
3. **Risk engine**: deterministic code, not an LLM. Every proposed order passes through it. It can only shrink or reject, never enlarge.
4. **Execution service**: gets a quote, calls `tx.build`, **verifies the unsigned tx matches the quote** (amounts, outputs, fee, destination is our wallet), then sends it to the signer.
5. **Signer**: separate process with the hot wallet key, a hard per-tx and per-day cap, and an allow-list of output scripts. Disabled entirely in paper mode.
6. **Event store + ledger**: SQLite (Postgres later). Every bot message, decision, order, fill and balance snapshot is an append-only event. The ledger values everything in PUSD.
7. **Trading desk web view**: read-only dashboard plus an owner-only kill switch.

Tech choices (proposed): TypeScript end to end. Node service for core/bots, `libauth` or `mainnet-js` for BCH tx verification and signing, Next.js (or Vite + React) for the desk, SQLite, deployed on one small VPS or Fly.io. Grok via the xAI API.

## 4. The bot team

Six agents, named after the inspiration terminal. Each has one job, a set of skills (tools), and someone it reports to.

| Agent | Role | Horizon | Skills (tools) | Reports to |
|---|---|---|---|---|
| **Nova** | Head trader / portfolio manager. Sets allocation across horizons, approves or rejects trade proposals, writes the daily report. | All | read ledger, read proposals, approve/reject, set budgets, write report | Human owner |
| **Orin** | Market scanner. Sweeps every Cauldron token every few minutes for volume spikes, new pools, TVL changes, price breakouts. | Short | indexer list/search, candles, volume, latest txs, first_pool | Vela |
| **Vela** | Research analyst. Turns Orin's signals into theses: fundamentals, BCMR metadata, community/X chatter (Grok's live search), dev-wallet and holder concentration. Writes trade proposals with entry, target, stop, size, horizon. | Medium / long | Grok web/X search, BCMR lookup, pool history, holder lookup | Nova |
| **Kade** | Risk officer. Rug checks, liquidity/slippage checks, position limits, drawdown limits. Has veto. Runs the deterministic risk engine and explains its verdict. | All | risk engine, quote simulation, slippage calc | Nova (veto independent of Nova) |
| **Rune** | Executor. Turns approved orders into quotes, builds and verifies txs, hands them to the signer, confirms fills, manages stops/targets. | Short | router quote/build/subscribe, tx verify, signer, broadcast | Nova |
| **Zara** | Journal and learning. Logs every trade outcome, computes win rate and P&L by strategy, writes post-mortems, and proposes rule changes that a human approves. Sends alerts. | All | ledger read, stats, alerting (Telegram), write lessons file | Nova and human owner |

Reporting graph:

```
                Human owner
                    │
                  Nova  ◀──── Zara (journal, alerts)
          ┌─────────┼──────────┐
        Vela      Kade        Rune
          ▲     (veto on      (executes only
        Orin     every trade)  approved orders)
```

The 24/7 loop: **Orin scans → Vela finds setups → Kade risk-checks → Nova approves → Rune executes → Zara logs, learns and alerts.**

Each bot's skill and role live in the repo as files (`bots/<name>/ROLE.md`, `bots/<name>/skills/*.md`, `bots/<name>/tools.json`) so they're versioned and editable, and the graph lives in `graph/team.yaml`.

## 5. Strategy book (initial)

| Horizon | Strategy | Default share of capital |
|---|---|---|
| Long | Core: hold PUSD. Optional BCH exposure when Nova's macro view is bullish. | 60% (mostly PUSD) |
| Medium | Established CashTokens with real liquidity: trend and mean-reversion on daily candles. | 25% |
| Short / "degen" | New tokens and volume spikes with 10x potential (per Dagur's suggestion). Small fixed bets, strict rug checks, fast stops. | 15% |

Bots may propose changes to these weights; changes above a threshold need human approval.

## 6. Risk controls (hard-coded, not prompt-based)

- **Paper mode first.** Launch runs against live prices with simulated fills. Live mode is a separate flag only the owner can flip.
- **Keys**: one dedicated hot wallet funded with a small amount. Keys live only in the signer, never in prompts, logs, the repo, or the bots' context.
- **Signer caps**: max per trade, max per day, outputs must go to our own address plus the router fee output.
- **Tx verification**: decode every `tx.build` result and reject if outputs, amounts or fee differ from the quote beyond tolerance.
- **Position limits**: max X% of portfolio per token, max Y% of a pool's liquidity per trade (slippage cap), max N open degen positions.
- **Rug checks before buying a new token**: pool age, TVL floor, holder/dev-wallet concentration, whether the creator can still mint (minting NFT exists), sudden LP withdrawals, BCMR metadata present.
- **Drawdown breakers**: pause all buying if portfolio down Z% in 24h; full halt and alert at a bigger threshold.
- **Kill switch** on the desk (owner only) and via Telegram.
- **Rate limits**: respect router `rate_limited` errors with backoff; one shared connection.
- **Audit trail**: every LLM prompt/response and tool call stored and shown on the desk.

Actual numbers for X/Y/Z/N and budgets are open questions below.

## 7. Trading desk website

Read-only for visitors, with an owner login for controls. Pages:

- **Desk overview**: total value in PUSD with a balance chart, P&L today/7d/all-time, win rate, mode badge (PAPER / LIVE), kill switch.
- **Agent comms**: the six agents as cards with live status ("scanning 214 tokens", "waiting for Kade"), and a chat-style feed of their messages to each other.
- **Activity log**: every scan, thesis, rug check, dev-wallet check, approval, veto, order and fill, with links to the tx on a block explorer.
- **Positions**: open positions with entry, current price, target, stop, horizon, owner agent.
- **Team graph**: the reporting structure rendered from `graph/team.yaml`.
- **Journal**: Zara's daily reports, post-mortems and lessons.

Updates stream live via Server-Sent Events.

## 8. Repo layout (github.com/jQrgen/trading-bots, private)

```
docs/            PLAN.md, ARCHITECTURE.md, RUNBOOK.md
graph/           team.yaml (agents, edges, permissions)
bots/<name>/     ROLE.md, skills/*.md, tools.json
packages/core/   scheduler, bus, ledger, risk engine
packages/market/ indexer + router clients
packages/exec/   quote → build → verify → sign → broadcast
packages/signer/ isolated signer (live mode only)
apps/desk/       trading desk website
```

## 9. Milestones

| # | When | Deliverable |
|---|---|---|
| M0 | Today (Oct 23) | This plan, repo scaffold, team graph and role files. |
| M1 | **Launch, Oct 24** | Market data service + all six bots running in **paper mode** on live Cauldron prices, and the desk website live showing agents, activity log, paper balance and win rate. |
| M2 | Oct 25 to 27 | Execution path tested end to end: quote, build, verify, and a dry-run sign that is never broadcast. Risk engine with tests. |
| M3 | After your go-ahead | **Live mode** with a small funded hot wallet and tight caps. Telegram alerts and kill switch. |
| M4 | Week 2+ | Zara's learning loop: weekly strategy review, weight changes, backtests from indexer candles. Consider riftenlabs-cli / WizardConnect for non-API venues. |

Launching tomorrow in paper mode gets the desk and team visible on schedule without risking funds while the bots prove themselves.

## 10. Open questions for you

1. **"Parity USD" = ParyonUSD (PUSD)?** That's the only BCH stablecoin matching the name, and it has the deepest Cauldron pool. Confirm.
2. **Starting capital and caps**: how much goes in the hot wallet at go-live, and what max per trade / per day / max drawdown are you comfortable with?
3. **Launch mode**: OK to launch tomorrow in paper mode and switch to live only after you approve?
4. **Grok access**: do you have an xAI API key and a preferred model? (It will be stored as a secret, never in the repo.)
5. **Hosting**: where should the desk and bots run (your VPS, Fly.io, Vercel + a worker)? Public URL or password-protected?
6. **Wallet**: generate a fresh dedicated wallet, or use riftenlabs-cli's built-in wallet?
7. **Alerts**: Telegram bot for alerts and kill switch?
8. **Degen appetite**: is 15% of capital in new-token bets right, or more/less?
