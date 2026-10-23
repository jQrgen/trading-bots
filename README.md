# trading-bots

A Grok-powered bot trading team and trading desk for the [Cauldron DEX](https://cauldron.quest) on Bitcoin Cash. The goal is to grow holdings measured in ParyonUSD (PUSD).

- **Grok Bot, start here:** [GROK_BOT.md](GROK_BOT.md)
- **Deploying the desk:** [GROK_SETUP.md](GROK_SETUP.md)
- **The plan:** [docs/PLAN.md](docs/PLAN.md)
- **Change the strategy:** on the trading desk, under Team knowledge (owner login)

GitHub holds code only. The team thinks inside the Grok Bot app and calls the desk's API (no xAI key needed). Everything else runs on Cloudflare: a Worker serves the trading desk and the team API, enforces the risk limits, simulates fills and watches the market every 15 minutes, and D1 holds all data, including the strategy, market notes, agent roles, risk limits, trades, proposals, every Grok call, scorecards and lessons. `seed/` has the starter defaults copied into D1 on first run. It currently runs in **paper mode**.
