import { activePools, broadcastTx, routerBuild, symbolOf, tokensByIds } from "./cauldron";
import { PUSD, type Env, type RiskLimits } from "./config";
import { DEFAULT_SERVERS, electrum, listUnspent } from "./chain/electrum";
import { bytesToHex, decodeTx, txidOf } from "./chain/tx";
import { buildPoolSwap, poolScript, type PoolCoin } from "./chain/pools";
import { fundingFor, swap, type BuildResult, type Coin, type SwapResult } from "./chain/swap";
import { scripthash, walletFrom, type Wallet } from "./chain/wallet";
import type { Ledger } from "./ledger";
import { Prices } from "./market";

/*
 * Live mode: real swaps on Cauldron from the bots' own hot wallet.
 *
 *  - The owner switches it on and off on the desk (settings.mode). It is off until then.
 *  - The key is a Worker secret (WALLET_SEED or WALLET_WIF), never in D1, logs, prompts or GitHub files.
 *  - Every swap: build (our own pool builder from live chain state; the router as a fallback) -> check the wallet's
 *    net change against the order -> sign our inputs -> broadcast.
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
    await reconcileCapital(env, c).catch((e: Error) => console.log(`capital flows: ${e.message}`));
  }
  return c;
}

const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

/**
 * Deposits and withdrawals the desk didn't make. Every coin the wallet holds is remembered; a new coin
 * that no desk transaction created is a deposit, and a remembered coin that is gone without a desk swap
 * spending it is a withdrawal. Each is valued in PUSD when seen, so P&L counts only trading results.
 */
export async function reconcileCapital(env: Env, coins: Coin[]) {
  if ((await modeOf(env)) !== "live") return;
  const known = new Map(
    (await env.DB.prepare("SELECT outpoint, txid, sats, asset, amount FROM wallet_coins").all<{ outpoint: string; txid: string; sats: number; asset: string | null; amount: string | null }>()).results.map((r) => [r.outpoint, r]),
  );
  const desk = new Set((await env.DB.prepare("SELECT DISTINCT txid FROM trades WHERE txid IS NOT NULL").all<{ txid: string }>()).results.map((r) => r.txid));
  const now = new Set(coins.map(outpoint));
  const fresh = coins.filter((c) => !known.has(outpoint(c)));
  const gone = [...known.values()].filter((r) => !now.has(r.outpoint));
  const deposits = fresh.filter((c) => !desk.has(c.txid));
  if (!fresh.length && !gone.length) return;
  let prices: Prices | null = null;
  if (deposits.length || gone.length) {
    const ids = [...new Set([PUSD, ...deposits.flatMap((c) => (c.token ? [c.token.category] : [])), ...gone.flatMap((r) => (r.asset ? [r.asset] : []))])];
    prices = new Prices(new Map((await tokensByIds(ids)).map((t) => [t.token_id, t])));
  }
  const worth = (sats: number, asset: string | null, amount: number) => prices!.value("bch", sats) + (asset ? prices!.value(asset, amount) : 0);
  const ts = Date.now();
  const flow = env.DB.prepare("INSERT INTO capital_flows (ts, kind, outpoint, asset, amount, pusd) VALUES (?, ?, ?, ?, ?, ?)");
  const stmts = [
    ...gone.map((r) => env.DB.prepare("DELETE FROM wallet_coins WHERE outpoint = ?").bind(r.outpoint)),
    // Desk swaps forget the coins they spend (forgetSpent), so whatever else vanished left the wallet.
    ...gone.map((r) => flow.bind(ts, "withdrawal", r.outpoint, r.asset ?? "bch", r.asset ? (r.amount ?? "0") : String(r.sats), -worth(r.sats, r.asset, Number(r.amount ?? 0)))),
    ...fresh.map((c) => env.DB.prepare("INSERT OR IGNORE INTO wallet_coins (outpoint, txid, sats, asset, amount) VALUES (?, ?, ?, ?, ?)").bind(outpoint(c), c.txid, Number(c.value), c.token?.category ?? null, c.token ? c.token.amount.toString() : null)),
    ...deposits.map((c) => flow.bind(ts, "deposit", outpoint(c), c.token?.category ?? "bch", c.token ? c.token.amount.toString() : c.value.toString(), worth(Number(c.value), c.token?.category ?? null, Number(c.token?.amount ?? 0)))),
  ];
  for (const c of deposits) stmts.push(event(env, `Owner deposit seen: ${c.token ? `${c.token.amount} units of ${c.token.category === PUSD ? "PUSD" : c.token.category.slice(0, 8)}` : `${Number(c.value) / 1e8} BCH`} (${explorerTx(c.txid)}). Counted as capital, not profit.`));
  for (const r of gone) stmts.push(event(env, `Coin ${r.outpoint.slice(0, 12)}… left the wallet without a desk trade. Counted as a withdrawal.`));
  await env.DB.batch(stmts);
}

/** A desk swap spent these coins: forget them so they aren't taken for a withdrawal. */
async function forgetSpent(env: Env, spent: Coin[]) {
  if (spent.length) await env.DB.batch(spent.map((c) => env.DB.prepare("DELETE FROM wallet_coins WHERE outpoint = ?").bind(outpoint(c))));
}

/** Net capital the owner has put in since going live, in PUSD at the time of each flow. */
export async function netDeposits(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT COALESCE(SUM(pusd), 0) AS n FROM capital_flows").first<{ n: number }>())?.n ?? 0;
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
/**
 * The current coins of a token's biggest Cauldron pools, read from Fulcrum. The indexer only tells us which
 * pools exist (owner pkh); their coins come from the chain, mempool included, so we never spend a stale one.
 */
export async function livePools(env: Env, category: string, top = 8): Promise<PoolCoin[]> {
  const rows = (await activePools(category)) as Array<{ owner_pkh?: string; sats: number }>;
  const owners = [...new Set(rows.sort((a, b) => b.sats - a.sats).map((r) => r.owner_pkh).filter((x): x is string => !!x && /^[0-9a-f]{40}$/.test(x)))].slice(0, top);
  // In parallel: one Electrum round trip per pool, done one after another, made the owner's Convert slow enough for phones to give up.
  const found = await Promise.all(owners.map((pkh) => listUnspent(servers(env), scripthash(poolScript(pkh))).catch(() => []).then((utxos) => ({ pkh, utxos }))));
  const pools: PoolCoin[] = [];
  for (const { pkh, utxos } of found) {
    for (const u of utxos) {
      if (u.token_data?.category !== category || u.token_data.nft) continue;
      pools.push({ txid: u.tx_hash, vout: u.tx_pos, sats: BigInt(u.value), tokens: BigInt(u.token_data.amount), category, pkh });
    }
  }
  return pools;
}

/** Swap builder: our own pool transaction from live pool coins, or the router's if we can't build one. */
function builder(env: Env, w: Wallet, coins: Coin[]) {
  return async (p: Record<string, unknown>): Promise<BuildResult> => {
    const sell = String(p.sell), buy = String(p.buy);
    try {
      const pools = (await Promise.all([sell, buy].filter((a) => a !== "bch").map((a) => livePools(env, a)))).flat();
      return buildPoolSwap({ sell, buy, amount: BigInt(String(p.amount)), minOutput: BigInt(String(p.min_output ?? "0")), pools, funding: fundingFor(coins, sell), script: w.script });
    } catch (e) {
      const r = await routerBuild<BuildResult>(p);
      return { ...r, route: { ...(r.route as object), direct_failed: (e as Error).message } };
    }
  };
}

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
    build: builder(env, w, coins),
    broadcast: async (hex: string) => {
      try {
        return await broadcastTx(hex);
      } catch (e) {
        const txid = txidOf(decodeTx(hex));
        // A node said no: the transaction itself is bad, so don't push it anywhere else.
        if (/REJECTED/.test((e as Error).message)) throw e;
        // Cauldron's broadcaster is down or unreachable (e.g. a 525). Fall back to the Electrum servers,
        // which relay to the network directly. Fulcrum answers with the txid, or an error if the node refuses it.
        const viaElectrum = await electrum(servers(env), "blockchain.transaction.broadcast", [hex]).catch((x: Error) => x);
        if (typeof viaElectrum === "string") return viaElectrum;
        // The first broadcast may still have gone through even though its answer didn't reach us. Check before calling it failed.
        await new Promise((r) => setTimeout(r, 3000));
        const seen = await electrum(servers(env), "blockchain.transaction.get", [txid]).catch(() => null);
        if (seen) return txid;
        throw new Error(`${(e as Error).message}; Electrum fallback: ${viaElectrum instanceof Error ? viaElectrum.message : JSON.stringify(viaElectrum)}`);
      }
    },
  };
  const r = await swap(w, coins, { sell, buy, amount: o.amount, minOutput, maxFeeSats: BigInt(o.maxFeeSats ?? RISK.liveMaxFeeSats) }, deps);
  await forgetSpent(env, r.spent).catch(() => undefined);
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
    env.DB.prepare("DELETE FROM wallet_coins"),
    env.DB.prepare("DELETE FROM capital_flows"),
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

/**
 * Diagnostics for the owner: build, verify and sign a swap exactly like a live trade, but never broadcast it.
 * Reports every input the transaction spends and whether the network (via Fulcrum) knows that coin.
 */
export async function dryRunSwap(env: Env, L: Ledger, RISK: RiskLimits, o: { sell: string; buy: string; amount: bigint }) {
  const w = await loadWallet(env);
  const coins = await coinsFor(env, L, w, true);
  let built: BuildResult | null = null;
  let signed = "";
  const build = builder(env, w, coins);
  let verdict = "signed (not broadcast)";
  try {
    await swap(w, coins, { sell: o.sell, buy: o.buy, amount: o.amount, minOutput: 0n, maxFeeSats: BigInt(RISK.liveMaxFeeSats) + o.amount / 100n }, {
      build: async (p) => (built = await build(p)),
      broadcast: async (hex) => {
        signed = hex;
        throw new Error("dry run: not broadcast");
      },
    });
  } catch (e) {
    if (!signed) verdict = `failed before signing: ${(e as Error).message}`;
  }
  const b = built as BuildResult | null;
  if (!b) return { verdict, coins: coins.length };
  const tx = decodeTx(signed || b.unsigned_tx_hex);
  const mine = new Set(coins.map((c) => `${c.txid}:${c.vout}`));
  const inputs = [];
  for (const i of tx.inputs) {
    const utxo = await electrum(servers(env), "blockchain.utxo.get_info", [i.txid, i.vout]).catch((e: Error) => ({ error: e.message }));
    const parent = await electrum(servers(env), "blockchain.transaction.get", [i.txid]).then(() => true, () => false);
    inputs.push({ txid: i.txid, vout: i.vout, ours: mine.has(`${i.txid}:${i.vout}`), parent_tx_known: parent, utxo });
  }
  // Is the router's pool state current? Compare with the chain tip and the indexer's live pools.
  const tip = await electrum(servers(env), "blockchain.headers.subscribe", []).then((h) => (h as { height?: number }).height, (e: Error) => e.message);
  const parents: Record<string, unknown> = {};
  for (const id of new Set(inputs.filter((i) => !i.ours).map((i) => i.txid))) {
    parents[id] = await electrum(servers(env), "blockchain.transaction.get", [id, true])
      .then((t) => { const v = t as { confirmations?: number; blockhash?: string; time?: number; vout?: unknown[] }; return { confirmations: v.confirmations ?? 0, blockhash: v.blockhash ?? null, time: v.time ?? null, outputs: v.vout?.length }; }, (e: Error) => ({ error: e.message }));
  }
  const token = o.sell === "bch" ? o.buy : o.sell;
  const rows = (await activePools(token).catch(() => [])) as Array<Record<string, unknown>>;
  const indexer_pools = [];
  for (const r of rows.slice(0, 8)) {
    const txid = String(r.txid ?? r.tx_hash ?? r.utxo_txid ?? "");
    const vout = Number(r.tx_pos ?? r.vout ?? r.utxo_vout ?? r.out_idx ?? -1);
    const utxo = txid && vout >= 0 ? await electrum(servers(env), "blockchain.utxo.get_info", [txid, vout]).catch((e: Error) => ({ error: e.message })) : "no outpoint in row";
    indexer_pools.push({ row: r, utxo });
  }
  return {
    verdict,
    tip,
    parents,
    indexer_pool_count: rows.length,
    indexer_pools,
    route: b.route,
    expected_output: b.expected_output,
    fee_sats: b.fee_sats,
    fee_token_amount: b.fee_token_amount,
    miner_fee_sats: b.miner_fee_sats,
    inputs_to_sign: b.inputs_to_sign,
    inputs,
    outputs: tx.outputs.map((x) => ({ value: x.value.toString(), script: bytesToHex(x.script), token: x.token ? { category: x.token.category, amount: x.token.amount.toString(), nft: !!x.token.nft } : null })),
    unsigned_tx_hex: b.unsigned_tx_hex,
  };
}
