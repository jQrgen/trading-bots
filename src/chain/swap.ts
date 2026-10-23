import { bytesToHex, decodeTx, encodeTx, txidOf, type Output, type Tx } from "./tx";
import type { Wallet } from "./wallet";

/*
 * One live swap: ask the Cauldron router for an unsigned transaction, check what it does to OUR wallet,
 * sign only our inputs, broadcast. The router is a beta service we don't control, so we never sign
 * on trust: the wallet's net change per asset must match the order, or nothing is signed.
 */

export interface Coin { txid: string; vout: number; value: bigint; token?: { category: string; amount: bigint } }

export interface BuildResult {
  unsigned_tx_hex: string;
  inputs_to_sign: number[];
  expected_output: string;
  fee_sats: string;
  fee_token_amount: string;
  miner_fee_sats: string;
  route?: unknown;
}

export interface SwapDeps {
  build(params: Record<string, unknown>): Promise<BuildResult>;
  broadcast(hex: string): Promise<string>;
}

export interface Order {
  sell: string; // "bch" or token category
  buy: string;
  amount: bigint; // exact-in, base units of `sell`
  minOutput: bigint; // slippage floor, base units of `buy`
  maxFeeSats: bigint; // most BCH the wallet may lose to miner and router fees (beyond `amount` when selling BCH)
}

export interface SwapResult { txid: string; sold: bigint; bought: bigint; bchDelta: bigint; feeSats: bigint; spent: Coin[]; created: Coin[] }

const key = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

/** Coins to fund an order: all coins of the sold token (or none when selling BCH) plus the plain BCH coins. */
export function fundingFor(coins: Coin[], sell: string): Coin[] {
  const tokens = sell === "bch" ? [] : coins.filter((c) => c.token?.category === sell);
  const bch = coins.filter((c) => !c.token).sort((a, b) => Number(b.value - a.value));
  return [...tokens, ...bch].slice(0, 500);
}

/** Net change of each asset in our wallet if this transaction confirms. "bch" is in sats. */
export function walletDelta(tx: Tx, ours: Map<string, Coin>, script: Uint8Array): Map<string, bigint> {
  const d = new Map<string, bigint>();
  const add = (k: string, v: bigint) => d.set(k, (d.get(k) ?? 0n) + v);
  for (const i of tx.inputs) {
    const c = ours.get(key(i));
    if (!c) continue;
    add("bch", -c.value);
    if (c.token) add(c.token.category, -c.token.amount);
  }
  const mine = bytesToHex(script);
  for (const o of tx.outputs) {
    if (bytesToHex(o.script) !== mine) continue;
    add("bch", o.value);
    if (o.token) add(o.token.category, o.token.amount);
  }
  return d;
}

/** Throws unless the router's transaction does exactly what the order asks, as seen from our wallet. */
export function verifyBuild(tx: Tx, toSign: number[], ours: Map<string, Coin>, script: Uint8Array, o: Order) {
  const ownIdx = tx.inputs.flatMap((inp, i) => (ours.has(key(inp)) ? [i] : []));
  if (toSign.length !== ownIdx.length || toSign.some((i) => !ownIdx.includes(i)))
    throw new Error(`router asked to sign inputs [${toSign}] but ours are [${ownIdx}]`);
  for (const out of tx.outputs) if (out.token?.nft && bytesToHex(out.script) === bytesToHex(script)) throw new Error("unexpected NFT output");
  const d = walletDelta(tx, ours, script);
  const get = (k: string) => d.get(k) ?? 0n;
  for (const [k, v] of d) if (k !== "bch" && k !== o.sell && k !== o.buy && v < 0n) throw new Error(`transaction would take ${-v} of token ${k.slice(0, 8)}`);
  if (o.sell !== "bch" && get(o.sell) < -o.amount) throw new Error(`sells ${-get(o.sell)}, order is ${o.amount}`);
  if (o.buy !== "bch" && get(o.buy) < o.minOutput) throw new Error(`receives ${get(o.buy)}, floor is ${o.minOutput}`);
  const bchFloor = o.sell === "bch" ? -(o.amount + o.maxFeeSats) : o.buy === "bch" ? o.minOutput - o.maxFeeSats : -o.maxFeeSats;
  if (get("bch") < bchFloor) throw new Error(`BCH change ${get("bch")} sats is below the allowed ${bchFloor}`);
  return d;
}

export async function swap(wallet: Wallet, coins: Coin[], o: Order, deps: SwapDeps): Promise<SwapResult> {
  const funding = fundingFor(coins, o.sell);
  if (!funding.some((c) => !c.token)) throw new Error("no plain BCH in the wallet to pay network fees");
  const scriptHex = bytesToHex(wallet.script);
  const built = await deps.build({
    sell: o.sell,
    buy: o.buy,
    amount: o.amount.toString(),
    side: "sell",
    funding: funding.map((c) => ({
      txid: c.txid, vout: c.vout, value: c.value.toString(), script_hex: scriptHex,
      ...(c.token ? { token: { category: c.token.category, amount: c.token.amount.toString() } } : {}),
    })),
    receive_addr: wallet.tokenAddress,
    change_addr: wallet.address,
    min_output: o.minOutput.toString(),
    signing_mode: "preimage",
  });
  const tx = decodeTx(built.unsigned_tx_hex);
  const ours = new Map(funding.map((c) => [key(c), c]));
  const d = verifyBuild(tx, built.inputs_to_sign, ours, wallet.script, o);
  for (const i of built.inputs_to_sign) {
    const c = ours.get(key(tx.inputs[i]))!;
    const spent: Output = { value: c.value, script: wallet.script, ...(c.token ? { token: c.token } : {}) };
    tx.inputs[i].unlocking = wallet.sign(tx, i, spent);
  }
  const hex = bytesToHex(encodeTx(tx));
  const txid = txidOf(tx);
  const sent = await deps.broadcast(hex);
  if (sent && sent !== txid) throw new Error(`broadcast returned ${sent}, expected ${txid}`);
  const spentCoins = tx.inputs.map((i) => ours.get(key(i))).filter((c): c is Coin => !!c);
  const created = tx.outputs.flatMap((out, vout) =>
    bytesToHex(out.script) === scriptHex && !out.token?.nft
      ? [{ txid, vout, value: out.value, ...(out.token ? { token: { category: out.token.category, amount: out.token.amount } } : {}) }]
      : [],
  );
  const get = (k: string) => d.get(k) ?? 0n;
  return {
    txid,
    sold: o.sell === "bch" ? -get("bch") : -get(o.sell),
    bought: get(o.buy),
    bchDelta: get("bch"),
    feeSats: BigInt(built.miner_fee_sats || "0") + BigInt(built.fee_sats || "0"),
    spent: spentCoins,
    created,
  };
}
