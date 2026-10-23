# trading-bots

A Grok-powered bot trading team and trading desk for the [Cauldron DEX](https://cauldron.quest) on Bitcoin Cash. The goal is to grow holdings measured in ParyonUSD (PUSD).

- **Grok Bot, start here:** [GROK_BOT.md](GROK_BOT.md)
- **Deploying the desk:** [GROK_SETUP.md](GROK_SETUP.md)
- **The plan:** [docs/PLAN.md](docs/PLAN.md)
- **Change the strategy:** on the trading desk, under Team knowledge (owner login)

GitHub holds code only. The team thinks inside the Grok Bot app and calls the desk's API (no xAI key needed). Everything else runs on Cloudflare: a Worker serves the trading desk and the team API, enforces the risk limits, simulates fills and watches the market every 15 minutes, and D1 holds all data, including the strategy, market notes, agent roles, risk limits, trades, proposals, every Grok call, scorecards and lessons. `seed/` has the starter defaults copied into D1 on first run. It runs in **paper mode** until the owner presses **Go live** on the desk; live mode trades real PUSD from a dedicated hot wallet (see "Live trading" below).

## Live trading

Live mode trades real money on Cauldron from one dedicated hot wallet. It is off until the owner switches it on.

1. **Wallet.** Make a fresh wallet just for the bots (for example in Cashonize) and save its 12-word seed phrase as the `WALLET_SEED` GitHub secret (or a single key as `WALLET_WIF`). The deploy copies it into a Worker secret. The key is never stored in D1, logged, or shown to the agents. The desk derives the address at `m/44'/145'/0'/0/0`; check that it matches your wallet app before funding.
2. **Fund it** with PUSD to trade and about 0.01 BCH for network fees. The desk always keeps `liveBchReserveSats` of BCH for fees.
3. **Go live** on the desk (Owner login, Live wallet panel, type GO LIVE). First the desk swaps all BCH above the fee reserve into PUSD (owner's rule: start from PUSD); if that swap fails, nothing changes. The paper book is archived (kept, not scored), and holdings become whatever the chain says the wallet holds.

How a live trade runs (`src/live.ts`, `src/chain/`): the risk engine and the live caps size the order (`liveMaxTradePusd`, `liveMaxDailyBuyPusd`). The Cauldron router builds an unsigned transaction (`tx.build`). The desk checks the wallet's net change per asset against the order (sells at most the order amount, receives at least the quote minus `liveSlippagePct`, spends at most `liveMaxFeeSats` of BCH on fees, touches no other token, and signs only our own inputs). Only then does it sign and broadcast through `broadcast.cauldron.quest`. Each trade links its transaction.

Brakes, from soft to hard: **Halt buys** (exits still run), **Freeze wallet** (no on-chain transaction at all, stops included), and **Back to paper** (once no live positions are open). You can always withdraw with your own wallet app, since you hold the seed. Liquidity providing stays paper-only for now.

## Credits

The desk playbook, trade-review discipline, cost-aware sizing and "unavailable is a verdict" rule are adapted from
[HyperGrok Trading Desk](https://github.com/galleonlabs/hypergrok-trading-desk) by Andrew Wilkinson and Galleon Labs (MIT),
rewritten and scaled down for Cauldron's much thinner liquidity.
