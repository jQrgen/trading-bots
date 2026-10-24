import { describe, expect, it } from "vitest";
import { createVirtualMachineBCH, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { bytesToHex, decodeTx, encodeTx, type Output } from "../src/chain/tx";
import { walletFrom } from "../src/chain/wallet";
import { buildLp, buildPoolSwap, poolScript, signLp, summonScript, verifyLp, satsOut, tokensOut, type LpOrder, type PoolCoin } from "../src/chain/pools";
import { verifyBuild, type Coin } from "../src/chain/swap";

const w = await walletFrom({ seed: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";

// Real pool owner from mainnet: its contract hashes to the P2SH32 the router's tx paid back to.
const REAL_PKH = "3410fe7cb078ea8d56e07e2137199f5736148c75";

const pools: PoolCoin[] = [
  { txid: "a1".repeat(32), vout: 4, sats: 2_474_903n, tokens: 910n, category: PUSD, pkh: REAL_PKH },
  { txid: "a2".repeat(32), vout: 0, sats: 14_406_539n, tokens: 5289n, category: PUSD, pkh: "bb".repeat(20) },
  { txid: "a3".repeat(32), vout: 1, sats: 12_369_167n, tokens: 4541n, category: PUSD, pkh: "cc".repeat(20) },
];
const TOK = "77".repeat(32);
pools.push({ txid: "a4".repeat(32), vout: 2, sats: 50_000_000n, tokens: 9_000_000n, category: TOK, pkh: "dd".repeat(20) });
const coins: Coin[] = [
  { txid: "01".repeat(32), vout: 0, value: 1000n, token: { category: PUSD, amount: 2000n } },
  { txid: "02".repeat(32), vout: 1, value: 17_498_425n },
];

function vmAccepts(hex: string, spent: Output[]) {
  const lib = decodeTransaction(hexToBin(hex));
  if (typeof lib === "string") throw new Error(lib);
  const sourceOutputs = spent.map((o) => {

    const enc = decodeTransaction(encodeTx({ version: 2, locktime: 0, inputs: [], outputs: [o] }));
    if (typeof enc === "string") throw new Error(enc);
    return enc.outputs[0];
  });
  return createVirtualMachineBCH(false).verify({ transaction: lib, sourceOutputs });
}

function signAndCheck(sell: string, buy: string, amount: bigint) {
  const b = buildPoolSwap({ sell, buy, amount, minOutput: 1n, pools, funding: coins, script: w.script });
  const tx = decodeTx(b.unsigned_tx_hex);
  const ours = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, c]));
  const d = verifyBuild(tx, b.inputs_to_sign, ours, w.script, { sell, buy, amount, minOutput: 1n, maxFeeSats: 5000n });
  const spent: Output[] = tx.inputs.map((i) => {
    const p = pools.find((x) => x.txid === i.txid && x.vout === i.vout);
    if (p) return { value: p.sats, script: poolScript(p.pkh), token: { category: p.category, amount: p.tokens } };
    const c = ours.get(`${i.txid}:${i.vout}`)!;
    return { value: c.value, script: w.script, ...(c.token ? { token: c.token } : {}) };
  });
  for (const i of b.inputs_to_sign) tx.inputs[i].unlocking = w.sign(tx, i, spent[i]);
  return { b, tx, d, spent, hex: bytesToHex(encodeTx(tx)) };
}

describe("direct Cauldron pool swaps", () => {
  it("derives the real pool address from its owner", () => {
    expect(bytesToHex(poolScript(REAL_PKH))).toBe("aa203d14337e4adef3396b1a167f4c5a0c87854ef12cdc10d6070ff9b84d504aae3187");
  });

  it("buys tokens with BCH in a transaction the pool contracts accept", () => {
    const { b, d, spent, hex } = signAndCheck("bch", PUSD, 17_000_000n);
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(d.get(PUSD)).toBe(BigInt(b.expected_output));
    expect(d.get("bch")! + 17_000_000n).toBeLessThan(0n); // paid amount plus a fee
    expect(-(d.get("bch")! + 17_000_000n)).toBeLessThan(5000n);
    expect(JSON.stringify(b.route)).toContain('"pools":3');
  });

  it("sells tokens for BCH in a transaction the pool contracts accept", () => {
    const { b, d, spent, hex } = signAndCheck(PUSD, "bch", 1500n);
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(d.get(PUSD)).toBe(-1500n);
    expect(d.get("bch")! > 0n).toBe(true);
    expect(BigInt(b.expected_output)).toBeGreaterThan(d.get("bch")!);
  });

  it("swaps token to token through BCH in one transaction the pool contracts accept", () => {
    const { b, d, spent, hex } = signAndCheck(PUSD, TOK, 1500n);
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(d.get(PUSD)).toBe(-1500n);
    expect(d.get(TOK)).toBe(BigInt(b.expected_output));
    expect(d.get(TOK)! > 0n).toBe(true);
    expect(-d.get("bch")!).toBeLessThan(5000n); // only the fee and dust
    expect(JSON.stringify(b.route)).toContain('"hops":2');
  });

  it("is refused by the contract when it takes one token too many", () => {
    const { tx, spent } = signAndCheck("bch", PUSD, 1_000_000n);
    const i = tx.outputs.findIndex((o) => o.token && o.value > 1000n);
    tx.outputs[i] = { ...tx.outputs[i], token: { category: PUSD, amount: tx.outputs[i].token!.amount - 1n } };
    expect(vmAccepts(bytesToHex(encodeTx(tx)), spent)).not.toBe(true);
  });

  function order(over: Partial<LpOrder> = {}): LpOrder {
    return {
      kind: "provide", pkh: w.pkh, pusd: PUSD, category: TOK, pusdIn: 1000n,
      minPoolBch: 1n, minPoolTokens: 1n, minPusdOut: 0n, maxFeeSats: 20_000n, own: [], ...over,
    };
  }

  function runLp(o: LpOrder) {
    const built = buildLp({ ...o, pools, funding: coins, script: w.script, priceSats: 0n, decimals: 0 });
    const tx = decodeTx(built.unsigned_tx_hex);
    const wallet = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, c]));
    const known = new Map<string, { value: bigint }>();
    for (const c of coins) known.set(`${c.txid}:${c.vout}`, { value: c.value });
    for (const p of [...pools, ...o.own]) known.set(`${p.txid}:${p.vout}`, { value: p.sats });
    const v = verifyLp(tx, built.inputs_to_sign, wallet, known, w.script, o);
    signLp(w, tx, built.inputs_to_sign, o.own, coins);
    const spent: Output[] = tx.inputs.map((i) => {
      const p = [...pools, ...o.own].find((x) => x.txid === i.txid && x.vout === i.vout);
      if (p) return { value: p.sats, script: poolScript(p.pkh), token: { category: p.category, amount: p.tokens } };
      const c = wallet.get(`${i.txid}:${i.vout}`)!;
      return { value: c.value, script: w.script, ...(c.token ? { token: c.token } : {}) };
    });
    return { built, tx, v, spent, hex: bytesToHex(encodeTx(tx)) };
  }

  it("locks a new pool the other pools accept, and announces it", () => {
    const { v, tx, spent, hex } = runLp(order());
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(v.fee >= BigInt(hex.length / 2)).toBe(true);
    expect(v.pusdSpent).toBe(1000n);
    expect(v.poolBch > 1n && v.poolTokens > 1n).toBe(true);
    expect(tx.inputs.every((i) => pools.some((p) => p.txid === i.txid) || coins.some((c) => c.txid === i.txid))).toBe(true);
    const pool = tx.outputs.find((o) => bytesToHex(o.script) === bytesToHex(poolScript(w.pkh)));
    expect(pool?.token).toMatchObject({ category: TOK, amount: v.poolTokens });
    expect(tx.outputs.some((o) => bytesToHex(o.script) === bytesToHex(summonScript(w.pkh)))).toBe(true);
  });

  it("refuses a pool paid to someone else, or a fee over the cap", () => {
    const o = order();
    const built = buildLp({ ...o, pools, funding: coins, script: w.script });
    const tx = decodeTx(built.unsigned_tx_hex);
    const wallet = new Map(coins.map((c) => [`${c.txid}:${c.vout}`, c]));
    const known = new Map<string, { value: bigint }>();
    for (const c of coins) known.set(`${c.txid}:${c.vout}`, { value: c.value });
    for (const p of pools) known.set(`${p.txid}:${p.vout}`, { value: p.sats });
    const stolen = decodeTx(built.unsigned_tx_hex);
    const i = stolen.outputs.findIndex((out) => bytesToHex(out.script) === bytesToHex(poolScript(w.pkh)));
    stolen.outputs[i] = { ...stolen.outputs[i], script: poolScript("11".repeat(20)) };
    expect(() => verifyLp(stolen, built.inputs_to_sign, wallet, known, w.script, o)).toThrow(/pool is/);
    expect(() => verifyLp(tx, built.inputs_to_sign, wallet, known, w.script, { ...o, maxFeeSats: 1n })).toThrow(/miner fee/);
  });

  it("adds to a pool we already own, and the owner signature spends the old one", () => {
    const own: PoolCoin = { txid: "b1".repeat(32), vout: 1, sats: 2_000_000n, tokens: 400_000n, category: TOK, pkh: w.pkh };
    const { v, tx, spent, hex } = runLp(order({ minPoolBch: own.sats + 1n, minPoolTokens: own.tokens + 1n, own: [own] }));
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(v.fee >= BigInt(hex.length / 2)).toBe(true);
    expect(v.poolBch > own.sats).toBe(true);
    expect(v.poolTokens > own.tokens).toBe(true);
    expect(tx.inputs.find((i) => i.txid === own.txid)!.unlocking.length).toBeGreaterThan(100);
  });

  it("withdraws our pool back to PUSD in a transaction the contracts accept", () => {
    const own: PoolCoin = { txid: "b2".repeat(32), vout: 0, sats: 5_000_000n, tokens: 1_000_000n, category: TOK, pkh: w.pkh };
    const { v, tx, spent, hex } = runLp(order({ kind: "withdraw", pusdIn: 0n, minPusdOut: 1n, own: [own] }));
    expect(vmAccepts(hex, spent)).toBe(true);
    expect(v.fee >= BigInt(hex.length / 2)).toBe(true);
    expect(v.pusdOut > 1n).toBe(true);
    expect(tx.outputs.some((o) => bytesToHex(o.script) === bytesToHex(poolScript(w.pkh)))).toBe(false);
  });

  it("prices like the constant-product formula", () => {
    const p = { sats: 1_000_000n, tokens: 1000n };
    expect(tokensOut(p, 100_000n)).toBe(90n); // 1000 - ceil(1e9 / 1_099_700)
    expect(satsOut(p, 100n)).toBeGreaterThan(90_000n);
    expect(satsOut(p, 100n)).toBeLessThan(91_000n);
  });
});
