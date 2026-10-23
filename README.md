# trading-bots

A Grok-powered bot trading team and trading desk for the [Cauldron DEX](https://cauldron.quest) on Bitcoin Cash. The goal is to grow holdings measured in ParyonUSD (PUSD).

- **Setting it up (humans or Grok):** [GROK_SETUP.md](GROK_SETUP.md)
- **The plan:** [docs/PLAN.md](docs/PLAN.md)
- **The team:** [graph/team.yaml](graph/team.yaml) and [bots/](bots/)
- **Change the strategy:** edit [bots/STRATEGY.md](bots/STRATEGY.md)

Everything runs on Cloudflare: a Worker runs the team every 15 minutes, D1 stores every trade, position, lesson, snapshot and bot message, and the same Worker serves the trading desk website. It currently runs in **paper mode**.
