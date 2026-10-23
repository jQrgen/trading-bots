import { describe, expect, it } from "vitest";
import { bytesToHex, decodeTx, encodeTx, hexToBytes, type Tx } from "../src/chain/tx";
import { walletFrom } from "../src/chain/wallet";
import { swap, type BuildResult, type Coin, type Order } from "../src/chain/swap";

const w = await walletFrom({ seed: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const TOK = "33".repeat(32);
const POOL = hexToBytes("aa20" + "44".repeat(32) + "87");
const THIEF = hexToBytes("76a914" + "55".repeat(20) + "88ac");

const coins: Coin[] = [
  { txid: "01".repeat(32), vout: 0, value: 1000n, token: { category: PUSD, amount: 10_000n } }, // 100 PUSD
  { txid: "02".repeat(32), vout: 1, value: 500_000n },
  { txid: "03".repeat(32), vout: 0, value: 1000n, token: { category: TOK, amount: 7n } }, // unrelated token, must not be touched
];

/** A router stand-in: spends our PUSD coin and BCH coin plus a pool, pays us `got` of TOK. */
function router(opts: { pusdBack?: bigint; got?: bigint; thief?: boolean; signPool?: boolean } = {}) {
  let seen: Record<string, unknown> | null = null;
  const build = async (params: Record<string, unknown>): Promise<BuildResult> => {
    seen = params;
    const tx: Tx = {
      version: 2, locktime: 0,
      inputs: [
        { txid: "aa".repeat(32), vout: 0, unlocking: Uint8Array.of(0x51), sequence: 0xffffffff },
        { txid: coins[0].txid, vout: 0, unlocking: new Uint8Array(), sequence: 0xffffffff },
        { txid: coins[1].txid, vout: 1, unlocking: new Uint8Array(), sequence: 0xffffffff },
      ],
      outputs: [
        { value: 1_000_000n, script: POOL, token: { category: TOK, amount: 1_000_000n } },
        { value: 1000n, script: w.script, token: { category: TOK, amount: opts.got ?? 5000n } },
        { value: 1000n, script: opts.thief ? THIEF : w.script, token: { category: PUSD, amount: opts.pusdBack ?? 7500n } },
        { value: 498_000n, script: w.script },
      ],
    };
    return {
      unsigned_tx_hex: bytesToHex(encodeTx(tx)),
      inputs_to_sign: opts.signPool ? [0, 1, 2] : [1, 2],
      expected_output: "5000", fee_sats: "0", fee_token_amount: "3", miner_fee_sats: "600",
    };
  };
  let sent = "";
  return { deps: { build, broadcast: async (hex: string) => ((sent = hex), "") }, seen: () => seen, sent: () => sent };
}

const order: Order = { sell: PUSD, buy: TOK, amount: 2500n, minOutput: 4900n, maxFeeSats: 5000n };

describe("live swap", () => {
  it("funds with the sold token and plain BCH only, verifies, signs our inputs and reports real amounts", async () => {
    const r = router();
    const res = await swap(w, coins, order, r.deps);
    const funding = (r.seen()!.funding as { txid: string }[]).map((f) => f.txid);
    expect(funding).toEqual([coins[0].txid, coins[1].txid]);
    expect(r.seen()!.receive_addr).toBe(w.tokenAddress);
    expect(res.sold).toBe(2500n);
    expect(res.bought).toBe(5000n);
    expect(res.bchDelta).toBe(-500_000n - 1000n + 1000n + 1000n + 498_000n);
    const signed = decodeTx(r.sent());
    expect(signed.inputs[1].unlocking.length).toBeGreaterThan(100);
    expect(signed.inputs[0].unlocking).toEqual(Uint8Array.of(0x51));
    expect(res.created.map((c) => c.vout)).toEqual([1, 2, 3]);
  });

  it("refuses a transaction that sends our tokens elsewhere", async () => {
    await expect(swap(w, coins, order, router({ thief: true }).deps)).rejects.toThrow(/sells/);
  });

  it("refuses less than the slippage floor", async () => {
    await expect(swap(w, coins, order, router({ got: 4000n }).deps)).rejects.toThrow(/floor/);
  });

  it("refuses to sign inputs that are not ours", async () => {
    await expect(swap(w, coins, order, router({ signPool: true }).deps)).rejects.toThrow(/sign inputs/);
  });

  it("refuses when fees would take too much BCH", async () => {
    await expect(swap(w, coins, { ...order, maxFeeSats: 100n }, router().deps)).rejects.toThrow(/BCH change/);
  });
});
