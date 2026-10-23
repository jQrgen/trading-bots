# trading-bots

A Grok-powered bot trading team and trading desk for the [Cauldron DEX](https://cauldron.quest) on Bitcoin Cash. The goal is to grow holdings measured in ParyonUSD (PUSD).

- **Setting it up (humans or Grok):** [GROK_SETUP.md](GROK_SETUP.md)
- **The plan:** [docs/PLAN.md](docs/PLAN.md)
- **Change the strategy:** on the trading desk, under Team knowledge (owner login)

GitHub holds code only. Everything runs on Cloudflare: a Worker runs the team every 15 minutes and serves the trading desk, and D1 holds all data, including the strategy, market notes, agent roles, risk limits, trades, proposals, every Grok call, scorecards and lessons. `seed/` has the starter defaults copied into D1 on first run. It currently runs in **paper mode**.
