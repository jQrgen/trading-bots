import { bytesToHex, concat, encodeTx, hash256, hexToBytes, type Output, type Tx } from "./tx";
import type { BuildResult, Coin } from "./swap";

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
  const sellBch = o.sell === "bch";
  const category = sellBch ? o.buy : o.sell;
  if (!sellBch && o.buy !== "bch") throw new Error("direct pool swaps are BCH <-> token only");
  const pools = o.pools.filter((p) => p.category === category && p.sats > 0n && p.tokens > 0n);
  if (!pools.length) throw new Error("no live pools for this token");
  const alloc = allocate(pools, sellBch, o.amount);
  if (!alloc.size) throw new Error("pools can't fill this order");
  const used = [...alloc.keys()];

  let got = 0n;
  const poolOutputs: Output[] = used.map((i) => {
    const p = pools[i], a = alloc.get(i)!;
    const script = poolScript(p.pkh);
    if (sellBch) {
      const t = tokensOut(p, a);
      got += t;
      return { value: p.sats + a, script, token: { category, amount: p.tokens - t } };
    }
    const s = satsOut(p, a);
    got += s;
    return { value: p.sats - s, script, token: { category, amount: p.tokens + a } };
  });
  if (got < o.minOutput) throw new Error(`pools give ${got}, floor is ${o.minOutput}`);

  // Our side: the sold tokens (when selling a token) plus plain BCH coins until fees are covered.
  const sold = sellBch ? [] : o.funding.filter((c) => c.token?.category === o.sell);
  const tokIn = sold.reduce((s, c) => s + c.token!.amount, 0n);
  if (!sellBch && tokIn < o.amount) throw new Error(`wallet has ${tokIn} of the token, order is ${o.amount}`);
  const plain = o.funding.filter((c) => !c.token).sort((a, b) => Number(b.value - a.value));
  const rate = o.feePerByte ?? 1n;

  const ours: Coin[] = [...sold];
  const tokenChange = tokIn - (sellBch ? 0n : o.amount);
  const outputs: Output[] = [...poolOutputs];
  if (sellBch) outputs.push({ value: TOKEN_DUST, script: o.script, token: { category, amount: got } });
  if (tokenChange > 0n) outputs.push({ value: TOKEN_DUST, script: o.script, token: { category, amount: tokenChange } });
  const change: Output = { value: 0n, script: o.script };
  outputs.push(change);

  const tx: Tx = { version: 2, locktime: 0, inputs: [], outputs };
  const setInputs = () => {
    tx.inputs = [
      ...used.map((i) => ({ txid: pools[i].txid, vout: pools[i].vout, unlocking: concat(Uint8Array.of(0x44), poolRedeem(pools[i].pkh)), sequence: 0xffffffff })),
      ...ours.map((c) => ({ txid: c.txid, vout: c.vout, unlocking: new Uint8Array(), sequence: 0xffffffff })),
    ];
  };
  const fee = () => {
    setInputs();
    return (BigInt(encodeTx(tx).length) + BigInt(ours.length) * (P2PKH_INPUT_BYTES - 41n) + 10n) * rate;
  };
  const inSats = () => ours.reduce((s, c) => s + c.value, 0n);
  const outSats = () => outputs.reduce((s, x) => s + x.value, 0n) - change.value;
  const poolIn = used.reduce((s, i) => s + pools[i].sats, 0n);
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

  const first = used.length;
  return {
    unsigned_tx_hex: bytesToHex(encodeTx(tx)),
    inputs_to_sign: ours.map((_, j) => first + j),
    expected_output: got.toString(),
    fee_sats: "0",
    fee_token_amount: "0",
    miner_fee_sats: f.toString(),
    route: { kind: "direct", pools: used.length, input_amount: o.amount.toString(), output_amount: got.toString() },
  };
}
