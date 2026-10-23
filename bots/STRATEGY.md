# Desk strategy

This is the owner's file. It is the only human input to the trading team.
Edit it on GitHub; the deploy action ships it and every agent reads it on the next cycle.
Hard risk limits live in `src/config.ts` (RISK) and are changed the same way.

## Goal

Maximise total holdings measured in ParyonUSD (PUSD).

## Allocation (target share of portfolio)

- **Long (about 60%)**: mostly PUSD. Hold BCH only when confident in BCH upside over weeks.
- **Medium (about 25%)**: established Cauldron tokens with real liquidity. Trend and mean reversion on daily candles. Hold for days to weeks.
- **Short / degen (about 15%)**: new tokens with 10x potential. Small fixed bets, fast stops, take profits into strength.

## Style

- Fewer, better trades. Doing nothing is fine.
- Never chase a candle that already moved more than 50% in a day.
- Prefer tokens with growing liquidity and many distinct liquidity providers.
- Cut losers fast, let winners run to target.
