import { broadcastTx, routerBuild, symbolOf } from "./cauldron";
import { PUSD, type Env, type RiskLimits } from "./config";
import { DEFAULT_SERVERS, electrum, listUnspent } from "./chain/electrum";
import { decodeTx, txidOf } from "./chain/tx";
import { swap, type BuildResult, type Coin, type SwapResult } from "./chain/swap";
import { scripthash, walletFrom, type Wallet } from "./chain/wallet";
import type { Ledger } from "./ledger";
import type { Prices } from "./market";

/*
 * Live mode: real swaps on Cauldron from the bots' own hot wallet.
 *
 *  - The owner switches it on and off on the desk (settings.mode). It is off until then.
 *  - The key is a Worker secret (WALLET_SEED or WALLET_WIF), never in D1, logs, prompts or GitHub files.
 *  - Every swap: router tx.build -> check the wallet's net change against the order -> sign our inputs -> broadcast.
 *  - Holdings are whatever the chain says the wallet holds, re-read every cycle.
 *  - "Freeze" stops every on-chain transaction at once, exits included.
 */

export type Mode = "paper" | "live";

export const hasWalletSecret = (env: Env) => !!(env.WALLET_SEED || env.WALLET_WIF);

let cached: { secret: string; wallet: Promise<Wallet> } | null = null;

export function loadWallet(env: Env): Promise<Wallet> {
  if (!hasWalletSecret(env)) return Promise.reject(new Error("no wallet secret: add WALLET_SEED as a GitHub secret and redeploy"));
  const secret = `${env.WALLET_SEED ?? ""}|${env.WALLET_WIF ?? ""}|${env.WALLET_PATH ?? ""}`;
  if (cached?.secret !== secret) cached = { secret, wallet: walletFrom({ seed: env.WALLET_SEED, wif: env.WALLET_WIF, path: env.WALLET_PATH }) };
  cached.wallet.catch(() => (cached = null));
  return cached.wallet;
}

const servers = (env: Env) => (env.ELECTRUM_SERVERS ? env.ELECTRUM_SERVERS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SERVERS);

const setting = async (env: Env, key: string) =>
  (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

export const modeOf = async (env: Env): Promise<Mode> => ((await setting(env, "mode")) === "live" ? "live" : "paper");
export const isFrozen = async (env: Env) => (await setting(env, "frozen")) === "1";

/** The wallet's spendable coins. NFTs are left alone: the router can't take them and the bots don't trade them. */
export async function fetchCoins(env: Env, w: Wallet): Promise<Coin[]> {
  const utxos = await listUnspent(servers(env), scripthash(w.script));
  return utxos
    .filter((u) => !u.token_data?.nft)
    .map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      value: BigInt(u.value),
      ...(u.token_data ? { token: { category: u.token_data.category, amount: BigInt(u.token_data.amount) } } : {}),
    }));
}

export function balancesOf(coins: Coin[]): Map<string, bigint> {
  const b = new Map<string, bigint>([["bch", 0n]]);
  for (const c of coins) {
    b.set("bch", b.get("bch")! + c.value);
    if (c.token) b.set(c.token.category, (b.get(c.token.category) ?? 0n) + c.token.amount);
  }
  return b;
}

/** Coins known to this cycle, kept up to date after each swap so chained swaps in one cycle don't double-spend. */
const cycleCoins = new WeakMap<Ledger, Coin[]>();

export async function coinsFor(env: Env, L: Ledger, w: Wallet, fresh = false): Promise<Coin[]> {
  let c = fresh ? undefined : cycleCoins.get(L);
  if (!c) {
    c = await fetchCoins(env, w);
    cycleCoins.set(L, c);
  }
  return c;
}

/** Make the holdings table match the chain. */
export async function syncHoldings(env: Env, L: Ledger, prices: Prices, coins: Coin[]) {
  const b = balancesOf(coins);
  const rows = [...b].filter(([, v]) => v > 0n);
  const sym = (a: string) => (a === "bch" ? "BCH" : a === PUSD ? "PUSD" : (prices.info(a) ? symbolOf(prices.info(a)!) : a.slice(0, 6)));
  const stmt = env.DB.prepare("INSERT INTO holdings (asset, symbol, amount) VALUES (?, ?, ?)");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM holdings"),
    ...rows.map(([a, v]) => stmt.bind(a === PUSD ? "pusd" : a, sym(a), Number(v))),
  ]);
}

export interface LiveFill extends SwapResult { verified: true }

/**
 * One real swap. `expectedOut` is the desk's own quote; the router's transaction must deliver at least
 * expectedOut minus the slippage allowance, and may spend at most RISK.liveMaxFeeSats of BCH on fees.
 */
export async function liveSwap(
  env: Env, L: Ledger, RISK: RiskLimits,
  o: { sell: string; buy: string; amount: bigint; expectedOut: bigint; slippagePct?: number; maxFeeSats?: number },
): Promise<LiveFill> {
  if (await isFrozen(env)) throw new Error("wallet frozen by the owner: no on-chain transactions");
  const w = await loadWallet(env);
  const coins = await coinsFor(env, L, w);
  const bal = balancesOf(coins);
  const sell = o.sell === "pusd" ? PUSD : o.sell;
  const buy = o.buy === "pusd" ? PUSD : o.buy;
  const have = bal.get(sell) ?? 0n;
  const spendable = sell === "bch" ? have - BigInt(RISK.liveBchReserveSats) : have;
  if (o.amount > spendable) throw new Error(`wallet has ${spendable} spendable of ${sell === "bch" ? "BCH sats" : sell.slice(0, 8)}, order needs ${o.amount}`);
  if ((bal.get("bch") ?? 0n) < BigInt(RISK.liveMaxFeeSats)) throw new Error("not enough BCH in the wallet for network fees");
  const slip = o.slippagePct ?? RISK.liveSlippagePct;
  const minOutput = (o.expectedOut * BigInt(Math.round((100 - slip) * 100))) / 10000n;
  const deps = {
    build: (p: Record<string, unknown>) => routerBuild<BuildResult>(p),
    broadcast: async (hex: string) => {
      try {
        return await broadcastTx(hex);
      } catch (e) {
        // The broadcast may have gone through even if its answer didn't reach us. Check before calling it failed.
        const txid = txidOf(decodeTx(hex));
        await new Promise((r) => setTimeout(r, 3000));
        const seen = await electrum(servers(env), "blockchain.transaction.get", [txid]).catch(() => null);
        if (seen) return txid;
        throw e;
      }
    },
  };
  const r = await swap(w, coins, { sell, buy, amount: o.amount, minOutput, maxFeeSats: BigInt(o.maxFeeSats ?? RISK.liveMaxFeeSats) }, deps);
  const spent = new Set(r.spent.map((c) => `${c.txid}:${c.vout}`));
  cycleCoins.set(L, [...coins.filter((c) => !spent.has(`${c.txid}:${c.vout}`)), ...r.created]);
  return { ...r, verified: true };
}

// Nordic Crypto's explorer (the owner's choice). Its search page opens the transaction or address it finds.
export const explorerUrl = (q: string) => `https://explorer.nordiccrypto.no/search/?q=${encodeURIComponent(q)}&chain=bch`;
export const explorerTx = explorerUrl;

const event = (env: Env, message: string) =>
  env.DB.prepare("INSERT INTO events (ts, agent, kind, message) VALUES (?, 'desk', 'admin', ?)").bind(Date.now(), message);
const put = (env: Env, key: string, value: string) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value);

/** What the desk shows about the live wallet. Public: the address and balances, never the key. */
export async function walletInfo(env: Env) {
  const base = { mode: await modeOf(env), frozen: await isFrozen(env), has_secret: hasWalletSecret(env), live_since: Number(await setting(env, "live_since")) || null };
  if (!base.has_secret) return { ...base, address: null };
  try {
    const w = await loadWallet(env);
    const coins = await fetchCoins(env, w).catch((e: Error) => e);
    if (coins instanceof Error) return { ...base, address: w.address, token_address: w.tokenAddress, error: coins.message };
    const b = balancesOf(coins);
    return {
      ...base,
      address: w.address,
      token_address: w.tokenAddress,
      bch_sats: Number(b.get("bch") ?? 0n),
      pusd: Number(b.get(PUSD) ?? 0n) / 100,
      tokens: [...b].filter(([k, v]) => k !== "bch" && k !== PUSD && v > 0n).map(([category, v]) => ({ category, amount: Number(v) })),
      coins: coins.length,
    };
  } catch (e) {
    return { ...base, address: null, error: (e as Error).message };
  }
}

/**
 * Owner switch to real money. The paper book is archived (kept, not scored) and the holdings become the wallet's.
 * Refuses unless the wallet can be read and holds PUSD (or BCH) to trade plus BCH for fees.
 */
export async function goLive(env: Env, RISK: RiskLimits): Promise<{ ok: boolean; error?: string; address?: string }> {
  if ((await modeOf(env)) === "live") return { ok: true };
  if (!hasWalletSecret(env)) return { ok: false, error: "no wallet secret: add WALLET_SEED as a GitHub secret and redeploy" };
  const w = await loadWallet(env);
  const b = balancesOf(await fetchCoins(env, w));
  const bch = b.get("bch") ?? 0n;
  if (bch < BigInt(RISK.liveBchReserveSats))
    return { ok: false, error: `the wallet needs at least ${RISK.liveBchReserveSats / 1e8} BCH for network fees; it has ${Number(bch) / 1e8}` };
  if ((b.get(PUSD) ?? 0n) === 0n && bch < 1_000_000n) return { ok: false, error: "the wallet has nothing to trade yet: send PUSD to it" };
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE positions SET status = 'archived', closed_at = ?, close_reason = 'paper book archived when the desk went live' WHERE status = 'open'").bind(now),
    env.DB.prepare("UPDATE lp_positions SET status = 'archived', closed_at = ?, close_reason = 'paper book archived when the desk went live' WHERE status = 'open'").bind(now),
    env.DB.prepare("DELETE FROM holdings"),
    env.DB.prepare("DELETE FROM settings WHERE key IN ('live_start_pusd', 'frozen')"),
    put(env, "live_since", String(now)),
    put(env, "mode", "live"),
    event(env, `Owner switched the desk to LIVE trading with wallet ${w.address}. The paper book is archived. Real swaps from the next decision on.`),
  ]);
  return { ok: true, address: w.address };
}

/** Back to paper, only with no live positions open (sell them first, or freeze). Starts a fresh paper wallet. */
export async function goPaper(env: Env): Promise<{ ok: boolean; error?: string }> {
  const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'").first<{ n: number }>())?.n ?? 0;
  if ((await modeOf(env)) === "live" && open > 0) return { ok: false, error: `${open} live positions are still open: let the team sell them first (Halt buys stops new ones)` };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM holdings"),
    put(env, "mode", "paper"),
    put(env, "initialized", "0"),
    event(env, "Owner switched the desk back to PAPER trading. The wallet keeps its funds; a fresh paper wallet starts next cycle."),
  ]);
  return { ok: true };
}

/** Emergency brake: no on-chain transaction at all, exits included, until the owner unfreezes. */
export async function setFrozen(env: Env, frozen: boolean) {
  await env.DB.batch([
    put(env, "frozen", frozen ? "1" : "0"),
    event(env, frozen ? "Owner FROZE the live wallet: no on-chain transactions at all, stops included." : "Owner unfroze the live wallet."),
  ]);
}
