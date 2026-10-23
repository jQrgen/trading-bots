export const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
export const PUSD_DECIMALS = 2;
export const BCH_DECIMALS = 8;

export const INDEXER = "https://indexer.riften.net/cauldron";
export const ROUTER_WS = "https://router.riften.net/v1/route";
export const ROUTER_FEE = 0.001;
export const BROADCAST = "https://broadcast.cauldron.quest/broadcast";

export type Horizon = "short" | "medium" | "long";

// Seed for the risk rules in D1 (knowledge key "risk-limits"). The engine reads that row.
// Only the owner can change it; bots cannot. maxOwnerSharePct null turns the single-LP rule off.
export const RISK_DEFAULTS = {
  maxPositionPct: { short: 3, medium: 10, long: 30 } as Record<Horizon, number>,
  maxBookPct: { short: 15, medium: 25, long: 60 } as Record<Horizon, number>,
  minTradePusd: 5,
  maxPriceImpactPct: 3,
  maxPoolSharePct: 2, // a buy may use at most this share of the pool's BCH side, so we can get out again
  minTvlBch: { short: 5, medium: 25, long: 100 } as Record<Horizon, number>,
  minPoolAgeHours: { short: 6, medium: 72, long: 720 } as Record<Horizon, number>,
  maxOwnerSharePct: null as number | null, // null: do not reject a pool because one LP owns it
  maxOpenShort: 5,
  maxStopPct: 50,
  dailyLossHaltPct: 10,
  maxTradesPerCycle: 10, // safety valve against a runaway loop, not a trading limit (owner: trade as often as it pays)
  maxBuysPerDay: 1000, // effectively off: the owner wants the bots to trade as often as the edge after costs allows
  // Size on what a stopped-out trade really costs, not the nominal stop (lesson from HyperGrok, scaled to Cauldron):
  // the stop can overshoot (the desk checks every 15 min and thin pools gap), the exit pays fees and price impact.
  maxRiskPerTradePct: { short: 1, medium: 2, long: 4 } as Record<Horizon, number>, // stressed loss, % of the book
  stopGapPct: 50, // assume a stop fills this much further away than set (12% stop -> 18% loss)
  minTargetToCostRatio: 3, // the target must be at least 3x the round-trip cost (fees + entry and exit impact)
  // Liquidity providing (paper): our own micro-pool earning the 0.3% fee, exposed to impermanent loss and rugs.
  maxLpPositionPct: 10, // one pool, % of the book
  maxLpBookPct: 40, // all pools together
  minLpTvlBch: 25,
  minLpPoolAgeHours: 72,
  maxLpPoolSharePct: 20, // our pool at most this share of the token's liquidity: we'd be the exit for everyone else
  lpStopPct: 25, // withdraw if pool value plus fees falls this far below the deposit
  lpDrainExitPct: 40, // withdraw if the token's liquidity drops this much in 24h (others are pulling out)
  minLpFeeAprPct: 10, // estimated fee APR must at least pay for the setup costs and the risk
  // Live mode only (real money). PUSD trades ~$20k a day, so start small and let results earn bigger sizes.
  liveMaxTradePusd: 25, // hard cap per buy, on top of every limit above
  liveMaxDailyBuyPusd: 150, // total buys in any 24h
  liveSlippagePct: 3, // the signed transaction must deliver at least the quote minus this, or nothing is signed
  liveBchReserveSats: 200000, // 0.002 BCH always kept for network fees, never traded
  liveMaxFeeSats: 20000, // most BCH one swap may spend on miner and router fees
};

/** Fees for PUSD -> BCH -> token -> BCH -> PUSD: four hops at 0.3% pool + 0.1% router. */
export const ROUND_TRIP_FEE_PCT = 1.6;

export type RiskLimits = typeof RISK_DEFAULTS;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  XAI_API_KEY?: string;
  ADMIN_TOKEN?: string;
  BOT_TOKEN?: string;
  BRAIN?: string;
  MODE: string;
  PAPER_START_PUSD: string;
  GROK_MODEL: string;
  JOURNAL_HOUR_UTC: string;
  INDEXER_URL?: string;
  ROUTER_URL?: string;
  XAI_BASE_URL?: string;
  BROADCAST_URL?: string;
  // Live trading (see src/live.ts). The wallet secret is a Worker secret, synced from GitHub on deploy.
  WALLET_SEED?: string; // BIP39 seed phrase of the bots' dedicated wallet
  WALLET_WIF?: string; // or a single WIF private key
  WALLET_PATH?: string; // derivation path for WALLET_SEED, default m/44'/145'/0'/0/0
  ELECTRUM_SERVERS?: string; // "host:port,host:port" Fulcrum servers (TLS) for the wallet's coins
}
