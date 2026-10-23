import { PUSD, PUSD_DECIMALS, ROUTER_FEE } from "./config";
import { activePools, decimalsOf, routerQuote, type TokenInfo } from "./cauldron";
import { priceImpactPct } from "./risk";

/** Live prices for one cycle, all expressed in PUSD per whole unit. */
export class Prices {
  readonly bchPusd: number;
  constructor(private tokens: Map<string, TokenInfo>) {
    const pusd = tokens.get(PUSD);
    if (!pusd?.price_now) throw new Error("no PUSD price from indexer");
    this.bchPusd = 1e8 / pusd.price_now; // price_now is sats per whole PUSD
  }
  info(id: string) { return this.tokens.get(id); }
  /** PUSD per whole token. */
  tokenPusd(id: string): number | null {
    if (id === "bch") return this.bchPusd;
    if (id === PUSD) return 1;
    const t = this.tokens.get(id);
    return t?.price_now ? (t.price_now / 1e8) * this.bchPusd : null;
  }
  decimals(id: string): number {
    if (id === "bch") return 8;
    if (id === PUSD) return PUSD_DECIMALS;
    const t = this.tokens.get(id);
    return t ? decimalsOf(t) : 0;
  }
  /** PUSD value of an amount in base units. */
  value(id: string, baseUnits: number): number {
    const p = this.tokenPusd(id);
    return p === null ? 0 : (baseUnits / 10 ** this.decimals(id)) * p;
  }
}

export interface Fill {
  amountOut: number; // base units of the bought asset
  impactPct: number;
  estimated: boolean;
  hops: string[];
  /** True when the router quote disagreed with pool reserves and the reserves were used. */
  reservePriced?: boolean;
}

const POOL_FEE_NUM = 3n;
const POOL_FEE_DEN = 1000n;

/** Tokens out for `dx` sats into one Cauldron pool (0.3% fee on the BCH moved). */
export function tokensOut(sats: bigint, tokens: bigint, dx: bigint): bigint {
  if (dx <= 0n || sats <= 0n || tokens <= 0n) return 0n;
  const fee = (dx * POOL_FEE_NUM) / POOL_FEE_DEN;
  const eff = sats + dx - fee;
  if (eff <= sats) return 0n;
  const newTokens = (sats * tokens + eff - 1n) / eff;
  return newTokens >= tokens ? 0n : tokens - newTokens;
}

/** Sats out for `dy` tokens into one Cauldron pool. */
export function satsOut(sats: bigint, tokens: bigint, dy: bigint): bigint {
  if (dy <= 0n || sats <= 0n || tokens <= 0n) return 0n;
  let lo = 0n;
  let hi = sats;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const fee = (mid * POOL_FEE_NUM) / POOL_FEE_DEN;
    const left = sats - mid - fee;
    if (left > 0n && left * (tokens + dy) >= sats * tokens) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

type Reserve = { sats: number; tokens?: number; token_amount?: number };

/** Split a swap across pools so the next chunk goes to the pool that pays the most. */
export function routePools(pools: Reserve[], amountIn: bigint, spendSats: boolean): { out: bigint; impactPct: number } {
  const live = pools
    .map((p) => ({ S: BigInt(Math.round(Number(p.sats))), T: BigInt(Math.round(Number(p.tokens ?? p.token_amount ?? 0))), used: 0n }))
    .filter((p) => p.S > 0n && p.T > 0n);
  if (!live.length || amountIn <= 0n) return { out: 0n, impactPct: Infinity };
  const spotSats = live.reduce((a, p) => a + p.S, 0n);
  const spotTokens = live.reduce((a, p) => a + p.T, 0n);
  const spot = Number(spotSats) / Number(spotTokens);
  let left = amountIn;
  for (let pass = 0; pass < 48 && left > 0n; pass++) {
    const step = left > 48n ? left / 16n : left;
    if (step <= 0n) break;
    let best = 0;
    let bestGain = 0n;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      const gain = spendSats
        ? tokensOut(p.S, p.T, p.used + step) - tokensOut(p.S, p.T, p.used)
        : satsOut(p.S, p.T, p.used + step) - satsOut(p.S, p.T, p.used);
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    if (bestGain === 0n) break;
    live[best].used += step;
    left -= step;
  }
  let out = 0n;
  for (const p of live) out += spendSats ? tokensOut(p.S, p.T, p.used) : satsOut(p.S, p.T, p.used);
  const eff = spendSats ? Number(amountIn) / Number(out) : Number(out) / Number(amountIn);
  const impactPct = spot > 0 && out > 0n && Number.isFinite(eff) ? (Math.abs(eff - spot) / spot) * 100 : Infinity;
  return { out, impactPct };
}

type QuoteFn = typeof routerQuote;
type PoolsFn = (token: string) => Promise<Reserve[]>;

/** A router quote this far from the pools is not a fill those reserves can clear. */
const RESERVE_DIVERGENCE = 0.08;

/** One hop. Pool reserves win when the router quote disagrees with them. */
async function hop(sell: string, buy: string, amountIn: number, prices: Prices, quote: QuoteFn, poolsFor: PoolsFn) {
  const token = sell === "bch" ? buy : buy === "bch" ? sell : null;
  let pooled: { out: number; impact: number } | null = null;
  if (token) {
    try {
      const pools = await poolsFor(token);
      if (pools?.length) {
        const r = routePools(pools, BigInt(Math.floor(amountIn)), sell === "bch");
        const out = Number(r.out) * (1 - ROUTER_FEE);
        if (out > 0 && Number.isFinite(out)) pooled = { out, impact: r.impactPct };
      }
    } catch {
      pooled = null;
    }
  }
  try {
    const q = await quote(sell, buy, BigInt(Math.floor(amountIn)));
    const quoted = Number(q.output_amount) * (1 - ROUTER_FEE);
    if (Number.isFinite(quoted) && quoted > 0) {
      if (pooled && Math.abs(quoted - pooled.out) / pooled.out > RESERVE_DIVERGENCE)
        return { out: pooled.out, impact: pooled.impact, estimated: false, reservePriced: true };
      return { out: quoted, impact: priceImpactPct(Number(q.market_pre_price), Number(q.market_post_price)), estimated: false, reservePriced: false };
    }
  } catch {
    /* router down or no output_amount */
  }
  if (pooled) return { out: pooled.out, impact: pooled.impact, estimated: false, reservePriced: true };
  const t = prices.info(token ?? (sell === "bch" ? buy : sell));
  const tvlSats = t?.tvl_sats ?? 0;
  const satsIn = sell === "bch" ? amountIn : (prices.value(sell, amountIn) / prices.bchPusd) * 1e8;
  // Constant-product approximation plus a 2% haircut for being an estimate.
  const impact = tvlSats > 0 ? (satsIn / tvlSats) * 200 : Infinity;
  const outPusd = (sell === "bch" ? (amountIn / 1e8) * prices.bchPusd : prices.value(sell, amountIn)) * (1 - impact / 100) * 0.98;
  const per = prices.tokenPusd(buy);
  const out = per ? (outPusd / per) * 10 ** prices.decimals(buy) : 0;
  return { out, impact, estimated: true, reservePriced: false };
}

/** Simulated swap from one asset to another, routed through BCH. */
export async function simulateSwap(from: string, to: string, amountIn: number, prices: Prices, quote: QuoteFn = routerQuote, poolsFor?: PoolsFn): Promise<Fill> {
  const load = poolsFor ?? (quote === routerQuote ? activePools : async () => []);
  const path = from === "bch" || to === "bch" ? [from, to] : [from, "bch", to];
  let amount = amountIn;
  let impact = 0;
  let estimated = false;
  let reservePriced = false;
  for (let i = 0; i < path.length - 1; i++) {
    const r = await hop(path[i], path[i + 1], amount, prices, quote, load);
    amount = r.out;
    impact = Math.max(impact, r.impact);
    estimated ||= r.estimated;
    reservePriced ||= r.reservePriced;
  }
  return { amountOut: Math.floor(amount), impactPct: impact, estimated, hops: path, reservePriced };
}
