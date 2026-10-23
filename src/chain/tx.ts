import { sha256 } from "@noble/hashes/sha2";

/*
 * Minimal Bitcoin Cash transaction codec with CashTokens, and the BCH signature hash.
 * Written by hand (instead of libauth) because Workers can't compile WebAssembly at runtime;
 * the tests check it against libauth's encoder and virtual machine.
 */

export interface TokenData {
  /** Display-order hex, as the indexer, the router and explorers show it. */
  category: string;
  amount: bigint;
  nft?: { capability: number; commitment: Uint8Array };
}
export interface Output { value: bigint; script: Uint8Array; token?: TokenData }
export interface Input { txid: string; vout: number; unlocking: Uint8Array; sequence: number }
export interface Tx { version: number; inputs: Input[]; outputs: Output[]; locktime: number }

export const hexToBytes = (hex: string) => {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const reverseHex = (hex: string) => bytesToHex(hexToBytes(hex).reverse());
export const hash256 = (b: Uint8Array) => sha256(sha256(b));
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
export function varint(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0xfdn) return Uint8Array.of(Number(v));
  if (v <= 0xffffn) return Uint8Array.of(0xfd, Number(v & 0xffn), Number(v >> 8n));
  if (v <= 0xffffffffn) return concat(Uint8Array.of(0xfe), u32(Number(v)));
  return concat(Uint8Array.of(0xff), u64(v));
}

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  bytes(n: number) {
    if (this.o + n > this.b.length) throw new Error("tx: truncated");
    return this.b.slice(this.o, (this.o += n));
  }
  u8() { return this.bytes(1)[0]; }
  u32() { return new DataView(this.bytes(4).buffer).getUint32(0, true); }
  u64() { return new DataView(this.bytes(8).buffer).getBigUint64(0, true); }
  varint(): bigint {
    const f = this.u8();
    if (f < 0xfd) return BigInt(f);
    if (f === 0xfd) { const x = this.bytes(2); return BigInt(x[0] | (x[1] << 8)); }
    if (f === 0xfe) return BigInt(this.u32());
    return this.u64();
  }
}

const PREFIX_TOKEN = 0xef;
const HAS_AMOUNT = 0x10, HAS_NFT = 0x20, HAS_COMMITMENT = 0x40;

export function encodeTokenPrefix(t: TokenData): Uint8Array {
  const nft = t.nft;
  const commitment = nft && nft.commitment.length ? nft.commitment : null;
  const bits = (t.amount > 0n ? HAS_AMOUNT : 0) | (nft ? HAS_NFT | nft.capability : 0) | (commitment ? HAS_COMMITMENT : 0);
  return concat(
    Uint8Array.of(PREFIX_TOKEN),
    hexToBytes(t.category).reverse(),
    Uint8Array.of(bits),
    commitment ? concat(varint(commitment.length), commitment) : new Uint8Array(),
    t.amount > 0n ? varint(t.amount) : new Uint8Array(),
  );
}

/** Split an output's script field into the token prefix (if any) and the locking script. */
function decodeScriptField(field: Uint8Array): { script: Uint8Array; token?: TokenData } {
  if (field[0] !== PREFIX_TOKEN) return { script: field };
  const r = new Reader(field);
  r.u8();
  const category = bytesToHex(r.bytes(32).reverse());
  const bits = r.u8();
  let commitment = new Uint8Array();
  if (bits & HAS_COMMITMENT) commitment = r.bytes(Number(r.varint()));
  const amount = bits & HAS_AMOUNT ? r.varint() : 0n;
  const token: TokenData = { category, amount };
  if (bits & HAS_NFT) token.nft = { capability: bits & 0x0f, commitment };
  return { script: field.slice(r.o), token };
}

export const encodeOutput = (o: Output) => {
  const field = concat(o.token ? encodeTokenPrefix(o.token) : new Uint8Array(), o.script);
  return concat(u64(o.value), varint(field.length), field);
};

export function decodeTx(hex: string): Tx {
  const r = new Reader(hexToBytes(hex));
  const version = r.u32();
  const inputs: Input[] = [];
  for (let n = Number(r.varint()); n > 0; n--) {
    const txid = bytesToHex(r.bytes(32).reverse());
    const vout = r.u32();
    const unlocking = r.bytes(Number(r.varint()));
    inputs.push({ txid, vout, unlocking, sequence: r.u32() });
  }
  const outputs: Output[] = [];
  for (let n = Number(r.varint()); n > 0; n--) {
    const value = r.u64();
    outputs.push({ value, ...decodeScriptField(r.bytes(Number(r.varint()))) });
  }
  const locktime = r.u32();
  if (r.o !== r.b.length) throw new Error("tx: trailing bytes");
  return { version, inputs, outputs, locktime };
}

const outpoint = (i: Input) => concat(hexToBytes(i.txid).reverse(), u32(i.vout));

export function encodeTx(tx: Tx): Uint8Array {
  return concat(
    u32(tx.version),
    varint(tx.inputs.length),
    ...tx.inputs.map((i) => concat(outpoint(i), varint(i.unlocking.length), i.unlocking, u32(i.sequence))),
    varint(tx.outputs.length),
    ...tx.outputs.map(encodeOutput),
    u32(tx.locktime),
  );
}

/** Transaction id in display order. */
export const txidOf = (tx: Tx) => bytesToHex(hash256(encodeTx(tx)).reverse());

export const SIGHASH_ALL_FORKID = 0x41;

/** BIP143-style BCH signing hash for SIGHASH_ALL | FORKID, including the spent output's token prefix. */
export function sighash(tx: Tx, index: number, spent: Output, scriptCode: Uint8Array): Uint8Array {
  const input = tx.inputs[index];
  const preimage = concat(
    u32(tx.version),
    hash256(concat(...tx.inputs.map(outpoint))),
    hash256(concat(...tx.inputs.map((i) => u32(i.sequence)))),
    outpoint(input),
    spent.token ? encodeTokenPrefix(spent.token) : new Uint8Array(),
    varint(scriptCode.length),
    scriptCode,
    u64(spent.value),
    u32(input.sequence),
    hash256(concat(...tx.outputs.map(encodeOutput))),
    u32(tx.locktime),
    u32(SIGHASH_ALL_FORKID),
  );
  return hash256(preimage);
}
