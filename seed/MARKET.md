# The market you trade: Cauldron DEX

Cauldron is a young, small DEX on Bitcoin Cash. It isn't Binance or Uniswap, and habits from big markets will lose money here.

## How it works

- **Every pool is token/BCH.** There are no token/token pools, so a trade from PUSD into a token is two swaps (PUSD to BCH, then BCH to the token). Each hop pays about a 0.3% pool fee plus the router's 0.1% fee, so a round trip into and out of a token costs roughly 1.6% before any price impact.
- **Micro-pools.** Each liquidity provider runs their own constant-product (x·y=k) micro-pools. The router combines several of them in one trade. Liquidity is whatever individual people happen to have deposited.
- **Only the pool's creator can withdraw.** One provider can pull most of a token's liquidity at any moment. If one owner holds most of the pools, treat it as a rug risk.
- **Prices are in satoshis.** Everything is priced against BCH. When BCH moves, every token's PUSD value moves with it, even if nothing happened to the token.
- **Unconfirmed chains.** Trades on the same pools chain off each other before they confirm. If one transaction in the chain is dropped or conflicts with another, every trade after it is dropped too. Don't treat a fill as final until it's confirmed.

## Pitfalls specific to this market

- **Thin liquidity.** Total TVL across all of Cauldron is about $1M, and daily volume is about $20k. Most tokens have only a few BCH of liquidity. A $50 trade can move the price several percent, so size to the pool, not to conviction.
- **Fake volume and rankings.** Cauldron ranks tokens by 30-day volume × √TVL. Wash trading can push a token up the list. A high rank is not a quality signal.
- **Rugs and dead tokens.** Anyone can mint a CashToken and open a pool in minutes. Most new tokens go to zero. Check pool age, how many distinct liquidity providers there are, and whether liquidity is growing or draining.
- **Stale prices.** A token with few trades can show a price that no one would actually pay. Trust router quotes over displayed prices.
- **Getting out costs too.** Exiting a thin pool can cost more in price impact than the gain. Before entering, check that you could sell the position back at an acceptable impact.
- **Small community, news moves fast.** Price action often follows one post on X or Telegram. Grok can search X; use it to check whether real people are talking about a token, and be suspicious of coordinated shilling.
- **PUSD is not a bank dollar.** It's a BCH-collateralised stablecoin with a soft peg. It usually trades within about ±1–4% of $1. A sharp BCH crash can stress the peg.
- **Beta infrastructure.** The router and indexer are in beta. Data can be missing or briefly wrong. When something looks impossible, assume bad data first.

## What usually works here

- Small positions in tokens with growing liquidity from several providers.
- Patience. One good entry beats ten churned trades that each pay about 1.6% in fees.
- Taking profit into spikes, because liquidity disappears on the way down.
