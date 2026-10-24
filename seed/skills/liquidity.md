# Skill: providing liquidity on Cauldron

Besides buying and selling, the desk can earn the 0.3% pool fee by running its own liquidity pool on Cauldron.
In paper mode the desk simulates a Cauldron micro-pool. In live mode an approved provide or withdraw is broadcast:
PUSD is swapped into BCH and the token, those two sides are locked in a pool the wallet owns, and a later withdraw
sells both sides back to PUSD. Same risk engine, live caps, slippage and fee limit as a swap. Vela proposes it, the risk
engine and Kade check it, Nova approves it.

## How a Cauldron pool earns and loses
- Every liquidity provider on Cauldron runs their own constant-product pool (BCH × token = k). The router sends
  trades through the pools with the best price, so roughly by share of liquidity.
- **Income:** 0.3% of the volume routed through our pool. Cauldron's whole DEX trades about $20k a day, so fee income
  is small and lumpy. The briefing shows an estimated fee APR per token (`liquidity.candidates`); it is an estimate
  from the indexer's volume figure, not a promise.
- **Impermanent loss:** when the token's price moves either way, the pool rebalances against us. A 2x move costs
  about 5.7% versus just holding; a 5x move about 25%. A token falling toward zero leaves us holding mostly that token.
- **Rug risk:** if other providers pull their liquidity or the token dumps, our pool becomes everyone's exit.
  The desk withdraws automatically when the token's liquidity drains 40% in a day or our pool falls past its stop.
- **Setup costs:** funding both sides costs about 1.2%, and withdrawing about the same plus exit impact.

## When providing beats trading
- Tokens with steady two-way volume and liquidity from several providers, where price ranges sideways.
- Estimated fee APR comfortably above impermanent loss you expect over the holding period, plus about 2.4% in costs.
- Not new tokens, not tokens trending hard in one direction (impermanent loss eats the fees), not pools dominated by one owner.

## Proposals
- Provide: `{"action":"provide","token_id":"...","symbol":"...","horizon":"long","size_pct":number,"stop_pct":number,"target_pct":0,"thesis":"...","bull_case":"...","bear_case":"..."}`
  `stop_pct` is how far the pool's value (including fees) may fall below the deposit before the desk withdraws (max 25%).
- Withdraw: `{"action":"withdraw","token_id":"...","symbol":"...","horizon":"long","size_pct":0,"target_pct":0,"stop_pct":0,"thesis":"why"}`
The engine caps one pool at 10% of the book, all pools at 40%, and our pool at 20% of the token's liquidity.
Zara reviews closed liquidity positions like trades: fees earned vs impermanent loss vs costs.
