import { describe, expect, it } from "vitest";
import {
  createVirtualMachineBCH,
  decodeTransaction,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  encodeCashAddress,
  encodePrivateKeyWif,
  encodeTransaction,
  hexToBin,
  privateKeyToP2pkhCashAddress,
} from "@bitauth/libauth";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex, decodeTx, encodeTx, hexToBytes, txidOf, type Output, type Tx } from "../src/chain/tx";
import { cashAddress, DEFAULT_PATH, walletFrom } from "../src/chain/wallet";

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CAT = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const OTHER = "11".repeat(32);

describe("wallet", () => {
  it("derives the same address as libauth from a seed phrase", async () => {
    const w = await walletFrom({ seed: SEED });
    const node = deriveHdPath(deriveHdPrivateNodeFromSeed(mnemonicToSeedSync(SEED)) as never, DEFAULT_PATH) as { privateKey: Uint8Array };
    const expected = privateKeyToP2pkhCashAddress({ privateKey: node.privateKey }) as { address: string };
    expect(w.address).toBe(expected.address);
    const wif = encodePrivateKeyWif(node.privateKey, "mainnet");
    expect((await walletFrom({ wif })).address).toBe(w.address);
  });

  it("encodes token-aware CashAddr like libauth", async () => {
    const pkh = hexToBytes("0123456789abcdef0123456789abcdef01234567");
    const r = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload: pkh }) as { address: string };
    expect(cashAddress(pkh, true)).toBe(r.address);
  });

  it("rejects a bad seed", async () => {
    await expect(walletFrom({ seed: "not a seed" })).rejects.toThrow();
  });
});

/** A swap-shaped tx: a pool input we don't own, our token UTXO and our BCH UTXO; outputs with tokens. */
function sampleTx(ours: Uint8Array): { tx: Tx; spent: Output[] } {
  const pool: Output = { value: 50_000_000n, script: hexToBytes("aa20" + "22".repeat(32) + "87"), token: { category: OTHER, amount: 1_000_000n } };
  const spent: Output[] = [
    pool,
    { value: 1000n, script: ours, token: { category: CAT, amount: 2500n } },
    { value: 200_000n, script: ours },
  ];
  const tx: Tx = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: "aa".repeat(32), vout: 0, unlocking: new Uint8Array(), sequence: 0xffffffff },
      { txid: "bb".repeat(32), vout: 1, unlocking: new Uint8Array(), sequence: 0xffffffff },
      { txid: "cc".repeat(32), vout: 2, unlocking: new Uint8Array(), sequence: 0xffffffff },
    ],
    outputs: [
      { value: 49_990_000n, script: pool.script, token: { category: OTHER, amount: 990_000n } },
      { value: 1000n, script: ours, token: { category: OTHER, amount: 10_000n } },
      { value: 1000n, script: ours, token: { category: CAT, amount: 2500n } },
      { value: 205_000n, script: ours },
    ],
  };
  return { tx, spent };
}

describe("transaction codec", () => {
  it("round-trips through libauth with CashTokens", async () => {
    const w = await walletFrom({ seed: SEED });
    const { tx } = sampleTx(w.script);
    const hex = bytesToHex(encodeTx(tx));
    const lib = decodeTransaction(hexToBin(hex));
    if (typeof lib === "string") throw new Error(lib);
    expect(bytesToHex(encodeTransaction(lib))).toBe(hex);
    expect(bytesToHex(encodeTx(decodeTx(hex)))).toBe(hex);
    expect(decodeTx(hex).outputs[2].token).toEqual({ category: CAT, amount: 2500n });
  });

  it("signs inputs that libauth's BCH virtual machine accepts", async () => {
    const w = await walletFrom({ seed: SEED });
    const { tx, spent } = sampleTx(w.script);
    // Make the pool input spendable by anyone for the test: OP_1 locking script, empty unlocking.
    spent[0] = { ...spent[0], script: Uint8Array.of(0x51) };
    tx.outputs[0] = { ...tx.outputs[0], script: Uint8Array.of(0x51) };
    for (const i of [1, 2]) tx.inputs[i].unlocking = w.sign(tx, i, spent[i]);
    const lib = decodeTransaction(encodeTx(tx));
    if (typeof lib === "string") throw new Error(lib);
    const sourceOutputs = spent.map((o) => {
      const encoded = decodeTransaction(encodeTx({ version: 2, locktime: 0, inputs: [], outputs: [o] }));
      if (typeof encoded === "string") throw new Error(encoded);
      return encoded.outputs[0];
    });
    const vm = createVirtualMachineBCH(false);
    expect(vm.verify({ transaction: lib, sourceOutputs })).toBe(true);
    // A tampered output must break the signature.
    tx.outputs[3] = { ...tx.outputs[3], value: 205_001n };
    const bad = decodeTransaction(encodeTx(tx));
    if (typeof bad === "string") throw new Error(bad);
    expect(vm.verify({ transaction: bad, sourceOutputs })).not.toBe(true);
    expect(txidOf(tx)).toMatch(/^[0-9a-f]{64}$/);
  });
});
