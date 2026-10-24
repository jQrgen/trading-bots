import { bytesToHex, concat, encodeTx, hash256, hexToBytes, type Output, type Tx } from "./tx";
import { walletDelta, type BuildResult, type Coin } from "./swap";
import type { Wallet } from "./wallet";

/*
 * Direct Cauldron pool swaps, built here instead of by the router.
 *
 * A Cauldron pool is a P2SH32 coin locked by a tiny constant-product contract (owner pkh baked in):
 *   - the pool's output at the same index as its input keeps the same script and token category,
 *   - (new_sats - fee) * new_tokens >= old_sats * old_tokens, with fee = |sats change| * 3 / 1000.
 * Trading needs no signature: the unlocking script is just the contract itself.
 *
 * We read each pool's current coin straight from the chain (Fulcrum), so a stale index can't hand us
 * coins that are already spent, which is what broke the router's builds.
 */

export interface PoolCoin { txid: string; vout: number; sats: bigint; tokens: bigint; category: string; pkh: string }

/** The pool contract for one owner. */
export const poolRedeem = (pkhHex: string) =>
  hexToBytes(`746376a914${pkhHex}88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268`);

/** P2SH32 locking script of an owner's pool: OP_HASH256 <hash256(contract)> OP_EQUAL. */
export const poolScript = (pkhHex: string) => concat(Uint8Array.of(0xaa, 0x20), hash256(poolRedeem(pkhHex)), Uint8Array.of(0x87));

const feeOf = (dSats: bigint) => ((dSats < 0n ? -dSats : dSats) * 3n) / 1000n;

/** Tokens out of a pool for `sats` in, the most the contract allows. */
export function tokensOut(p: { sats: bigint; tokens: bigint }, sats: bigint): bigint {
  if (sats <= 0n) return 0n;
  const k = p.sats * p.tokens;
  const eff = p.sats + sats - feeOf(sats);
  const keep = (k + eff - 1n) / eff; // ceil
  return p.tokens - keep > 0n ? p.tokens - keep : 0n;
}

/** Sats out of a pool for `tokens` in, the most the contract allows. */
export function satsOut(p: { sats: bigint; tokens: bigint }, tokens: bigint): bigint {
  if (tokens <= 0n) return 0n;
  const k = p.sats * p.tokens;
  const nt = p.tokens + tokens;
  const ok = (x: bigint) => (p.sats - x - feeOf(x)) * nt >= k;
  let lo = 0n, hi = p.sats - 1000n; // leave the pool above dust
  if (hi <= 0n || !ok(0n)) return 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (ok(mid)) lo = mid; else hi = mid - 1n;
  }
  return lo;
}

/** Split `amount` across pools in chunks, each chunk to the pool paying the most for it. Returns amount per pool index. */
export function allocate(pools: PoolCoin[], sellBch: boolean, amount: bigint, chunks = 60): Map<number, bigint> {
  const alloc = new Map<number, bigint>();
  const out = (i: number, a: bigint) => (sellBch ? tokensOut(pools[i], a) : satsOut(pools[i], a));
  const step = amount / BigInt(chunks) || amount;
  let left = amount;
  while (left > 0n) {
    const c = left < step ? left : step;
    let best = -1, gain = 0n;
    for (let i = 0; i < pools.length; i++) {
      const cur = alloc.get(i) ?? 0n;
      const g = out(i, cur + c) - out(i, cur);
      if (g > gain) { gain = g; best = i; }
    }
    if (best < 0) break; // no pool pays anything for more
    alloc.set(best, (alloc.get(best) ?? 0n) + c);
    left -= c;
  }
  for (const [i, a] of alloc) if (out(i, a) <= 0n) alloc.delete(i);
  return alloc;
}

/** What the pools would pay for `amount` right now, split the same way a build splits it. */
export function quotePools(pools: PoolCoin[], sellBch: boolean, amount: bigint): bigint {
  let out = 0n;
  for (const [i, a] of allocate(pools, sellBch, amount)) out += sellBch ? tokensOut(pools[i], a) : satsOut(pools[i], a);
  return out;
}

const TOKEN_DUST = 1000n;
const P2PKH_INPUT_BYTES = 148n; // with a 72-byte signature and compressed key

/**
 * Build an unsigned swap through Cauldron pools, in the router's result shape so the same
 * verify-then-sign path checks it. Pool inputs come first (each pool's output at its own index),
 * then our funding coins; our outputs follow.
 */
export function buildPoolSwap(o: {
  sell: string; buy: string; amount: bigint; minOutput: bigint;
  pools: PoolCoin[]; funding: Coin[]; script: Uint8Array; feePerByte?: bigint;
}): BuildResult {
  if (o.sell === o.buy) throw new Error("sell and buy are the same asset");
  // Token to token goes through BCH: sell into the first token's pools, buy from the second's, in one transaction.
  const legs = o.sell === "bch" || o.buy === "bch"
    ? [{ category: o.sell === "bch" ? o.buy : o.sell, sellBch: o.sell === "bch" }]
    : [{ category: o.sell, sellBch: false }, { category: o.buy, sellBch: true }];
  const usedPools: PoolCoin[] = [];
  const poolOutputs: Output[] = [];
  let amount = o.amount;
  for (const leg of legs) {
    const pools = o.pools.filter((p) => p.category === leg.category && p.sats > 0n && p.tokens > 0n);
    if (!pools.length) throw new Error(`no live pools for token ${leg.category.slice(0, 8)}`);
    const alloc = allocate(pools, leg.sellBch, amount);
    if (!alloc.size) throw new Error("pools can't fill this order");
    let got = 0n;
    for (const [i, a] of alloc) {
      const p = pools[i];
      const script = poolScript(p.pkh);
      usedPools.push(p);
      if (leg.sellBch) {
        const t = tokensOut(p, a);
        got += t;
        poolOutputs.push({ value: p.sats + a, script, token: { category: leg.category, amount: p.tokens - t } });
      } else {
        const x = satsOut(p, a);
        got += x;
        poolOutputs.push({ value: p.sats - x, script, token: { category: leg.category, amount: p.tokens + a } });
      }
    }
    // A middle leg's BCH must all go into the next leg; any rounding left over stays with us as change.
    amount = got;
  }
  const got = amount;
  if (got < o.minOutput) throw new Error(`pools give ${got}, floor is ${o.minOutput}`);

  // Our side: the sold tokens (when selling a token) plus plain BCH coins until fees are covered.
  const sold = o.sell === "bch" ? [] : o.funding.filter((c) => c.token?.category === o.sell);
  const tokIn = sold.reduce((s, c) => s + c.token!.amount, 0n);
  if (o.sell !== "bch" && tokIn < o.amount) throw new Error(`wallet has ${tokIn} of the token, order is ${o.amount}`);
  const plain = o.funding.filter((c) => !c.token).sort((a, b) => Number(b.value - a.value));
  const rate = o.feePerByte ?? 1n;

  const ours: Coin[] = [...sold];
  const outputs: Output[] = [...poolOutputs];
  if (o.buy !== "bch") outputs.push({ value: TOKEN_DUST, script: o.script, token: { category: o.buy, amount: got } });
  if (tokIn > o.amount && o.sell !== "bch") outputs.push({ value: TOKEN_DUST, script: o.script, token: { category: o.sell, amount: tokIn - o.amount } });
  const change: Output = { value: 0n, script: o.script };
  outputs.push(change);

  const tx: Tx = { version: 2, locktime: 0, inputs: [], outputs };
  const setInputs = () => {
    tx.inputs = [
      ...usedPools.map((p) => ({ txid: p.txid, vout: p.vout, unlocking: concat(Uint8Array.of(0x44), poolRedeem(p.pkh)), sequence: 0xffffffff })),
      ...ours.map((c) => ({ txid: c.txid, vout: c.vout, unlocking: new Uint8Array(), sequence: 0xffffffff })),
    ];
  };
  const fee = () => {
    setInputs();
    return (BigInt(encodeTx(tx).length) + BigInt(ours.length) * (P2PKH_INPUT_BYTES - 41n) + 10n) * rate;
  };
  const inSats = () => ours.reduce((s, c) => s + c.value, 0n);
  const outSats = () => outputs.reduce((s, x) => s + x.value, 0n) - change.value;
  const poolIn = usedPools.reduce((s, p) => s + p.sats, 0n);
  // BCH balance of the whole tx: pools in + ours in = all outputs + fee.
  const need = () => outSats() + fee() - poolIn + 546n;
  for (const c of plain) {
    if (inSats() >= need()) break;
    ours.push(c);
  }
  const f = fee();
  change.value = poolIn + inSats() - outSats() - f;
  if (change.value < 546n) throw new Error("not enough plain BCH for this swap and its fee");
  setInputs();

  const first = usedPools.length;
  return {
    unsigned_tx_hex: bytesToHex(encodeTx(tx)),
    inputs_to_sign: ours.map((_, j) => first + j),
    expected_output: got.toString(),
    fee_sats: "0",
    fee_token_amount: "0",
    miner_fee_sats: f.toString(),
    route: { kind: "direct", hops: legs.length, pools: usedPools.length, input_amount: o.amount.toString(), output_amount: got.toString() },
  };
}

/** OP_RETURN the indexer watches for: SUMMON + the owner's pkh, so a new pool is found before its first trade. */
export const summonScript = (pkhHex: string) => hexToBytes(`6a0653554d4d4f4e14${pkhHex}`);

const push = (b: Uint8Array) => concat(Uint8Array.of(b.length), b);
const WITHDRAW_UNLOCK_BYTES = 180n; // sig + pubkey + redeem script, with a byte of room
const point = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

/** Sell `amount` across one token's pools. sellBch means sats in, tokens out. */
function routeLeg(pools: PoolCoin[], category: string, sellBch: boolean, amount: bigint) {
  const list = pools.filter((p) => p.category === category && p.sats > 0n && p.tokens > 0n);
  if (!list.length) throw new Error(`no live pools for token ${category.slice(0, 8)}`);
  const alloc = allocate(list, sellBch, amount);
  let spent = 0n;
  for (const a of alloc.values()) spent += a;
  // Selling a token has to move the whole amount. Selling BCH can stop a few sats
  // short, where another sat buys no token; the caller keeps that BCH as change.
  if (!alloc.size || (!sellBch && spent !== amount)) throw new Error("pools can't fill this order");
  const used: { pool: PoolCoin; output: Output }[] = [];
  let got = 0n;
  for (const [i, a] of alloc) {
    const p = list[i];
    const script = poolScript(p.pkh);
    if (sellBch) {
      const t = tokensOut(p, a);
      got += t;
      used.push({ pool: p, output: { value: p.sats + a, script, token: { category, amount: p.tokens - t } } });
    } else {
      const x = satsOut(p, a);
      got += x;
      used.push({ pool: p, output: { value: p.sats - x, script, token: { category, amount: p.tokens + a } } });
    }
  }
  if (got <= 0n) throw new Error("pools can't fill this order");
  return { used, got };
}

export interface LpOrder {
  kind: "provide" | "withdraw";
  pkh: string;
  pusd: string;
  category: string;
  /** Provide: PUSD base units to spend. Withdraw: 0. */
  pusdIn: bigint;
  minPoolBch: bigint;
  minPoolTokens: bigint;
  minPusdOut: bigint;
  maxFeeSats: bigint;
  own: PoolCoin[];
}

/**
 * Add or remove our own Cauldron pool in one transaction.
 * Provide sells PUSD for BCH, buys the token with half of that BCH, and locks the two sides
 * in a pool this pkh can withdraw. An existing pool is spent (owner path) and recreated larger.
 * Withdraw spends our pool and sells both sides back to PUSD.
 */
export function buildLp(o: LpOrder & {
  pools: PoolCoin[]; funding: Coin[]; script: Uint8Array;
  priceSats?: bigint; decimals?: number; feePerByte?: bigint;
}): BuildResult {
  if (o.category === o.pusd || o.category === "bch") throw new Error("a pool pairs a token with BCH");
  const ownKeys = new Set(o.own.map(point));
  const pools = o.pools.filter((p) => p.pkh !== o.pkh && !ownKeys.has(point(p)));
  const own = o.own.filter((p) => p.category === o.category);
  const ownBch = own.reduce((s, p) => s + p.sats, 0n);
  const ownTok = own.reduce((s, p) => s + p.tokens, 0n);

  let legs: { pool: PoolCoin; output: Output }[] = [];
  let body: Output[] = [];
  let poolBch = 0n;
  let poolTokens = 0n;
  let pusdOut = 0n;
  let sellToken: string | undefined;
  let sellAmount = 0n;

  if (o.kind === "provide") {
    if (o.pusdIn <= 0n) throw new Error("nothing to deposit");
    const sold = routeLeg(pools, o.pusd, false, o.pusdIn);
    const bchForTok = sold.got / 2n;
    if (bchForTok <= 0n) throw new Error("deposit is too small to fund both sides");
    const bought = routeLeg(pools, o.category, true, bchForTok);
    let newBch = sold.got - bchForTok;
    const scale = 10n ** BigInt(o.decimals ?? 0);
    const price = o.priceSats ?? 0n;
    if (price > 0n && scale > 0n) {
      const value = (bought.got * price) / scale;
      const floor = o.minPoolBch - ownBch;
      if (value >= floor && value > 0n && value < newBch) newBch = value;
    }
    poolBch = newBch + ownBch;
    poolTokens = bought.got + ownTok;
    if (poolBch < o.minPoolBch) throw new Error(`pool BCH ${poolBch} is under the floor ${o.minPoolBch}`);
    if (poolTokens < o.minPoolTokens) throw new Error(`pool tokens ${poolTokens} are under the floor ${o.minPoolTokens}`);
    legs = [...sold.used, ...bought.used];
    body = [
      ...legs.map((l) => l.output),
      { value: poolBch, script: poolScript(o.pkh), token: { category: o.category, amount: poolTokens } },
      { value: 0n, script: summonScript(o.pkh) },
    ];
    sellToken = o.pusd;
    sellAmount = o.pusdIn;
  } else {
    if (!own.length) throw new Error("no pool of ours to withdraw");
    const tokenLeg = ownTok > 0n ? routeLeg(pools, o.category, false, ownTok) : { used: [], got: 0n };
    const available = ownBch + tokenLeg.got;
    const reserve = 8000n;
    if (available <= reserve) throw new Error("pool is too small to withdraw after fees");
    const pusdLeg = routeLeg(pools, o.pusd, true, available - reserve);
    pusdOut = pusdLeg.got;
    if (pusdOut < o.minPusdOut) throw new Error(`withdraw pays ${pusdOut} PUSD, floor is ${o.minPusdOut}`);
    legs = [...tokenLeg.used, ...pusdLeg.used];
    body = [
      ...legs.map((l) => l.output),
      { value: TOKEN_DUST, script: o.script, token: { category: o.pusd, amount: pusdOut } },
    ];
  }

  const rate = o.feePerByte ?? 1n;
  const soldCoins = sellToken ? o.funding.filter((c) => c.token?.category === sellToken) : [];
  const tokIn = soldCoins.reduce((s, c) => s + c.token!.amount, 0n);
  if (sellAmount > 0n && tokIn < sellAmount) throw new Error(`wallet has ${tokIn} of the token, order is ${sellAmount}`);
  const plain = o.funding.filter((c) => !c.token).sort((a, b) => Number(b.value - a.value));
  const ours: Coin[] = [...soldCoins];
  const outputs: Output[] = [...body];
  if (sellAmount > 0n && tokIn > sellAmount) outputs.push({ value: TOKEN_DUST, script: o.script, token: { category: sellToken!, amount: tokIn - sellAmount } });
  const change: Output = { value: 0n, script: o.script };
  outputs.push(change);
  const tx: Tx = { version: 2, locktime: 0, inputs: [], outputs };
  const setInputs = () => {
    tx.inputs = [
      ...legs.map((l) => ({ txid: l.pool.txid, vout: l.pool.vout, unlocking: push(poolRedeem(l.pool.pkh)), sequence: 0xffffffff })),
      ...own.map((p) => ({ txid: p.txid, vout: p.vout, unlocking: new Uint8Array(), sequence: 0xffffffff })),
      ...ours.map((c) => ({ txid: c.txid, vout: c.vout, unlocking: new Uint8Array(), sequence: 0xffffffff })),
    ];
  };
  const fee = () => {
    setInputs();
    const extra = BigInt(ours.length) * (P2PKH_INPUT_BYTES - 41n) + BigInt(own.length) * WITHDRAW_UNLOCK_BYTES + 10n;
    return (BigInt(encodeTx(tx).length) + extra) * rate;
  };
  const walletIn = () => ours.reduce((s, c) => s + c.value, 0n);
  const poolIn = () => legs.reduce((s, l) => s + l.pool.sats, 0n);
  const outNoChange = () => outputs.reduce((s, x) => s + x.value, 0n) - change.value;
  const need = () => {
    const n = outNoChange() + fee() + 546n - poolIn() - ownBch;
    return n > 0n ? n : 0n;
  };
  for (const c of plain) {
    if (walletIn() >= need()) break;
    ours.push(c);
  }
  const f = fee();
  change.value = poolIn() + ownBch + walletIn() - outNoChange() - f;
  if (change.value < 546n) throw new Error("not enough plain BCH for this transaction and its fee");
  if (f > o.maxFeeSats) throw new Error(`miner fee ${f} sats is over the limit ${o.maxFeeSats}`);
  setInputs();
  const firstOwn = legs.length;
  return {
    unsigned_tx_hex: bytesToHex(encodeTx(tx)),
    inputs_to_sign: [...own.map((_, j) => firstOwn + j), ...ours.map((_, j) => firstOwn + own.length + j)],
    expected_output: (o.kind === "provide" ? poolTokens : pusdOut).toString(),
    fee_sats: "0",
    fee_token_amount: "0",
    miner_fee_sats: f.toString(),
    route: { kind: o.kind === "provide" ? "lp-provide" : "lp-withdraw", pool_bch: poolBch.toString(), pool_tokens: poolTokens.toString(), pusd_out: pusdOut.toString(), own: own.length },
  };
}

/** Throws unless the transaction does what the LP order asks and nothing else. */
export function verifyLp(tx: Tx, toSign: number[], walletCoins: Map<string, Coin>, known: Map<string, { value: bigint }>, script: Uint8Array, o: LpOrder) {
  const ownKeys = new Set(o.own.map(point));
  const ownIdx = tx.inputs.flatMap((inp, i) => (ownKeys.has(point(inp)) ? [i] : []));
  const walletIdx = tx.inputs.flatMap((inp, i) => (walletCoins.has(point(inp)) ? [i] : []));
  if (ownIdx.length !== o.own.length) throw new Error("transaction does not spend our pool");
  const expect = [...ownIdx, ...walletIdx];
  if (toSign.length !== expect.length || toSign.some((i) => !expect.includes(i))) throw new Error(`asked to sign inputs [${toSign}] but ours are [${expect}]`);
  for (const inp of tx.inputs) if (!known.has(point(inp))) throw new Error("transaction spends an unknown input");
  const mine = bytesToHex(script);
  for (const out of tx.outputs) if (out.token?.nft && bytesToHex(out.script) === mine) throw new Error("unexpected NFT output");
  let inSats = 0n;
  for (const inp of tx.inputs) inSats += known.get(point(inp))!.value;
  const fee = inSats - tx.outputs.reduce((s, out) => s + out.value, 0n);
  if (fee < 0n || fee > o.maxFeeSats) throw new Error(`miner fee ${fee} sats is over the limit ${o.maxFeeSats}`);
  const d = walletDelta(tx, walletCoins, script);
  for (const [k, v] of d) {
    if (k === "bch" || k === o.pusd) continue;
    if (k === o.category) {
      if (v < 0n) throw new Error(`would spend ${-v} of the pooled token from the wallet`);
      continue;
    }
    if (v < 0n) throw new Error(`transaction would take ${-v} of token ${k.slice(0, 8)}`);
  }
  if ((d.get("bch") ?? 0n) < -o.maxFeeSats) throw new Error(`BCH change ${d.get("bch")} sats is below the allowed ${-o.maxFeeSats}`);
  const poolHex = bytesToHex(poolScript(o.pkh));
  const locked = tx.outputs.filter((out) => bytesToHex(out.script) === poolHex && out.token?.category === o.category);
  const poolBch = locked.reduce((s, out) => s + out.value, 0n);
  const poolTokens = locked.reduce((s, out) => s + (out.token?.amount ?? 0n), 0n);
  if (o.kind === "withdraw") {
    if (locked.length) throw new Error("withdraw would leave a pool behind");
    const got = d.get(o.pusd) ?? 0n;
    if (got < o.minPusdOut) throw new Error(`receives ${got} PUSD, floor is ${o.minPusdOut}`);
    return { poolBch: 0n, poolTokens: 0n, pusdOut: got, pusdSpent: 0n, fee };
  }
  if (!(poolBch >= o.minPoolBch) || !(poolTokens >= o.minPoolTokens)) throw new Error(`pool is ${poolBch} sats and ${poolTokens} tokens, floors are ${o.minPoolBch} and ${o.minPoolTokens}`);
  if (!tx.outputs.some((out) => bytesToHex(out.script) === bytesToHex(summonScript(o.pkh)))) throw new Error("pool announcement missing");
  const spent = -((d.get(o.pusd) ?? 0n) < 0n ? d.get(o.pusd)! : 0n);
  if (spent > o.pusdIn) throw new Error(`spends ${spent} PUSD, order is ${o.pusdIn}`);
  return { poolBch, poolTokens, pusdOut: 0n, pusdSpent: spent, fee };
}

/** Sign our pool inputs (owner withdraw path) and our wallet inputs. Pool trades stay unsigned by us. */
export function signLp(wallet: Wallet, tx: Tx, toSign: number[], own: PoolCoin[], coins: Coin[]) {
  for (const i of toSign) {
    const inp = tx.inputs[i];
    const pool = own.find((p) => p.txid === inp.txid && p.vout === inp.vout);
    if (pool) {
      const redeem = poolRedeem(pool.pkh);
      const spent: Output = { value: pool.sats, script: poolScript(pool.pkh), token: { category: pool.category, amount: pool.tokens } };
      tx.inputs[i].unlocking = concat(wallet.sign(tx, i, spent, redeem), push(redeem));
    } else {
      const c = coins.find((x) => x.txid === inp.txid && x.vout === inp.vout);
      if (!c) throw new Error("signing an input the wallet doesn't have");
      tx.inputs[i].unlocking = wallet.sign(tx, i, { value: c.value, script: wallet.script, ...(c.token ? { token: c.token } : {}) });
    }
  }
}
