import { BROADCAST, INDEXER, ROUTER_WS, type Env } from "./config";

let indexer = INDEXER;
let router = ROUTER_WS;
let broadcastUrl = BROADCAST;

/** Optional endpoint overrides, used for local testing against a mock server. */
export function configureEndpoints(env: Env) {
  indexer = env.INDEXER_URL || INDEXER;
  router = env.ROUTER_URL || ROUTER_WS;
  broadcastUrl = env.BROADCAST_URL || BROADCAST;
}

export interface TokenInfo {
  token_id: string;
  display_symbol?: string;
  display_name?: string;
  bcmr?: { token?: { decimals?: number; symbol?: string } };
  tvl_sats: number;
  tvl_tokens: number;
  trade_volume?: number;
  first_pool_ts?: number;
  price_now?: number; // sats per whole token
  price_now_usd?: number;
  change_24h_bp?: number;
  change_7d_bp?: number;
  score_rank?: number;
}

export interface Pool {
  owner_pkh?: string;
  pkh?: string;
  sats: number;
  /** Base units of the token. The indexer field is `tokens`. */
  tokens: number;
  /** Alternate name used by older fixtures. */
  token_amount?: number;
}

export interface Quote {
  input_amount: string;
  output_amount: string;
  market_pre_price: string;
  market_post_price: string;
  estimated?: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(indexer + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`indexer ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const decimalsOf = (t: TokenInfo) => t.bcmr?.token?.decimals ?? 0;
export const symbolOf = (t: TokenInfo) =>
  t.display_symbol || t.bcmr?.token?.symbol || t.token_id.slice(0, 6);

export const topTokens = (limit = 100) =>
  getJson<TokenInfo[]>(`/tokens/list_cached?limit=${limit}&by=score&order=desc`);

export const tokensByIds = (ids: string[]) =>
  ids.length ? getJson<TokenInfo[]>(`/tokens/list_cached_by_ids?ids=${ids.join(",")}`) : Promise.resolve([]);

export const activePools = (token: string) =>
  getJson<Array<Partial<Pool>> | { active?: Array<Partial<Pool>> }>(`/pool/active?token=${token}`).then((r) => {
    const rows = Array.isArray(r) ? r : r.active ?? [];
    return rows.map((p) => ({
      ...p,
      sats: Number(p.sats),
      tokens: Number(p.tokens ?? p.token_amount ?? 0),
    })) as Pool[];
  });

export interface Candle { ts?: number; open: number; high: number; low: number; close: number }

export async function candles(token: string, days: number, stepSeconds: number): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const r = await getJson<unknown>(`/price/${token}/candlesticks?start=${start}&end=${end}&stepsize=${stepSeconds}`);
  const rows = Array.isArray(r) ? r : ((r as { candles?: unknown[] }).candles ?? []);
  return rows as Candle[];
}

/** Launchpad (IDO) sales. The launchpad API lives next to /cauldron on the same indexer host. */
export async function launchpadList(): Promise<Record<string, unknown>[]> {
  const res = await fetch(indexer.replace(/\/cauldron$/, "") + "/ido/list?limit=100", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`launchpad: ${res.status}`);
  const r = await res.json();
  return Array.isArray(r) ? r : ((r as { idos?: Record<string, unknown>[] }).idos ?? []);
}

/** One JSON-RPC call to the Cauldron router over its WebSocket. */
async function routerCall<T>(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(router, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`router: no websocket (${res.status})`);
  ws.accept();
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("router: timeout")), timeoutMs);
      ws.addEventListener("message", (ev) => {
        clearTimeout(timer);
        const msg = JSON.parse(String(ev.data));
        if (msg.error) reject(new Error(`router: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result as T);
      });
      ws.addEventListener("close", () => reject(new Error("router: closed")));
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** Exact-in quote from the Cauldron router. sell/buy are "bch" or a token category. */
export const routerQuote = (sell: string, buy: string, amount: bigint) =>
  routerCall<Quote>("route.quote", { sell, buy, amount: amount.toString(), side: "sell" });

/** Unsigned swap transaction from the router (tx.build). The router never broadcasts. */
export const routerBuild = <T>(params: Record<string, unknown>) => routerCall<T>("tx.build", params, 20_000);

/** Broadcast a signed transaction through Cauldron's broadcast API (avoids double-spend races on chained pool trades). */
export async function broadcastTx(hex: string): Promise<string> {
  const res = await fetch(broadcastUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: hex }) });
  const body = (await res.json().catch(() => ({}))) as { txid?: string; error?: { code?: string; message?: string } };
  if (!res.ok || body.error || !body.txid) throw new Error(`broadcast: ${body.error?.code ?? res.status} ${body.error?.message ?? ""}`.trim());
  return body.txid;
}
