import { PUSD, PUSD_DECIMALS, ROUTER_FEE } from "./config";
import { decimalsOf, routerQuote, type TokenInfo } from "./cauldron";
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
}

type QuoteFn = typeof routerQuote;

/** One router hop, falling back to an indexer-price estimate if the router is down. */
async function hop(sell: string, buy: string, amountIn: number, prices: Prices, quote: QuoteFn) {
  try {
    const q = await quote(sell, buy, BigInt(Math.floor(amountIn)));
    const out = Number(q.output_amount) * (1 - ROUTER_FEE);
    return { out, impact: priceImpactPct(Number(q.market_pre_price), Number(q.market_post_price)), estimated: false };
  } catch {
    const token = sell === "bch" ? buy : sell;
    const t = prices.info(token);
    const tvlSats = t?.tvl_sats ?? 0;
    const satsIn = sell === "bch" ? amountIn : (prices.value(sell, amountIn) / prices.bchPusd) * 1e8;
    // Constant-product approximation plus a 2% haircut for being an estimate.
    const impact = tvlSats > 0 ? (satsIn / tvlSats) * 200 : Infinity;
    const outPusd = (sell === "bch" ? (amountIn / 1e8) * prices.bchPusd : prices.value(sell, amountIn)) * (1 - impact / 100) * 0.98;
    const per = prices.tokenPusd(buy);
    const out = per ? (outPusd / per) * 10 ** prices.decimals(buy) : 0;
    return { out, impact, estimated: true };
  }
}

/** Simulated swap from one asset to another, routed through BCH. */
export async function simulateSwap(from: string, to: string, amountIn: number, prices: Prices, quote: QuoteFn = routerQuote): Promise<Fill> {
  const path = from === "bch" || to === "bch" ? [from, to] : [from, "bch", to];
  let amount = amountIn;
  let impact = 0;
  let estimated = false;
  for (let i = 0; i < path.length - 1; i++) {
    const r = await hop(path[i], path[i + 1], amount, prices, quote);
    amount = r.out;
    impact = Math.max(impact, r.impact);
    estimated ||= r.estimated;
  }
  return { amountOut: Math.floor(amount), impactPct: impact, estimated, hops: path };
}
