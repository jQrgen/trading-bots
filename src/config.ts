export const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
export const PUSD_DECIMALS = 2;
export const BCH_DECIMALS = 8;

export const INDEXER = "https://indexer.riften.net/cauldron";
export const ROUTER_WS = "https://router.riften.net/v1/route";
export const ROUTER_FEE = 0.001;

export type Horizon = "short" | "medium" | "long";

// Hard limits. Agents can't change these; edit and redeploy to change them.
export const RISK = {
  maxPositionPct: { short: 3, medium: 10, long: 30 } as Record<Horizon, number>,
  maxBookPct: { short: 15, medium: 25, long: 60 } as Record<Horizon, number>,
  minTradePusd: 5,
  maxPriceImpactPct: 3,
  maxPoolSharePct: 2, // a buy may use at most this share of the pool's BCH side, so we can get out again
  minTvlBch: { short: 5, medium: 25, long: 100 } as Record<Horizon, number>,
  minPoolAgeHours: { short: 6, medium: 72, long: 720 } as Record<Horizon, number>,
  maxOwnerSharePct: 90,
  maxOpenShort: 5,
  maxStopPct: 50,
  dailyLossHaltPct: 10,
  maxTradesPerCycle: 3,
};

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  XAI_API_KEY?: string;
  ADMIN_TOKEN?: string;
  MODE: string;
  PAPER_START_PUSD: string;
  GROK_MODEL: string;
  JOURNAL_HOUR_UTC: string;
  INDEXER_URL?: string;
  ROUTER_URL?: string;
}
