import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { createBase58check } from "@scure/base";
import { bytesToHex, concat, sighash, SIGHASH_ALL_FORKID, type Output, type Tx } from "./tx";

/*
 * The bots' hot wallet: one P2PKH key. The secret lives only in the Worker (WALLET_SEED or WALLET_WIF),
 * synced from a GitHub secret on deploy. It is never logged, stored in D1, or shown to the agents.
 */

export const DEFAULT_PATH = "m/44'/145'/0'/0/0"; // Cashonize, Paytaca and Electron Cash's first receive address

export interface Wallet {
  address: string; // bitcoincash:q...
  tokenAddress: string; // bitcoincash:z... (token-aware, for receiving CashTokens)
  script: Uint8Array; // P2PKH locking script
  pubkey: Uint8Array;
  pkh: string; // hash160(pubkey), hex. The owner of any pool this wallet creates.
  sign(tx: Tx, index: number, spent: Output, scriptCode?: Uint8Array): Uint8Array; // unlocking script
}

export async function walletFrom(secret: { seed?: string; wif?: string; path?: string }): Promise<Wallet> {
  let priv: Uint8Array;
  if (secret.seed) {
    const words = secret.seed.trim().toLowerCase().split(/\s+/).join(" ");
    if (!validateMnemonic(words, wordlist)) throw new Error("WALLET_SEED is not a valid BIP39 seed phrase");
    const node = HDKey.fromMasterSeed(await mnemonicToSeed(words)).derive(secret.path || DEFAULT_PATH);
    if (!node.privateKey) throw new Error("could not derive the wallet key");
    priv = node.privateKey;
  } else if (secret.wif) {
    const raw = createBase58check(sha256).decode(secret.wif.trim());
    if (raw[0] !== 0x80 || raw.length !== 34 || raw[33] !== 0x01) throw new Error("WALLET_WIF must be a compressed mainnet WIF key");
    priv = raw.slice(1, 33);
  } else throw new Error("no wallet secret");
  const pubkey = secp256k1.getPublicKey(priv, true);
  const pkh = ripemd160(sha256(pubkey));
  const script = p2pkh(pkh);
  return {
    address: cashAddress(pkh, false),
    tokenAddress: cashAddress(pkh, true),
    script,
    pubkey,
    pkh: bytesToHex(pkh),
    sign(tx, index, spent, scriptCode?) {
      const sig = secp256k1.sign(sighash(tx, index, spent, scriptCode ?? script), priv, { lowS: true }).toDERRawBytes();
      const s = concat(sig, Uint8Array.of(SIGHASH_ALL_FORKID));
      return concat(Uint8Array.of(s.length), s, Uint8Array.of(pubkey.length), pubkey);
    },
  };
}

/** BIP39 seed via WebCrypto's PBKDF2: native, so it doesn't eat the Worker's CPU budget like a JS loop would. */
async function mnemonicToSeed(words: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(words.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: enc.encode("mnemonic"), iterations: 2048 }, key, 512);
  return new Uint8Array(bits);
}

export const p2pkh = (pkh: Uint8Array) => concat(Uint8Array.of(0x76, 0xa9, 0x14), pkh, Uint8Array.of(0x88, 0xac));

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): bigint {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

/** CashAddr for a 20-byte P2PKH hash; tokenAware gives the z... form that signals CashTokens support. */
export function cashAddress(pkh: Uint8Array, tokenAware: boolean, prefix = "bitcoincash"): string {
  const payload = concat(Uint8Array.of(tokenAware ? 0x10 : 0x00), pkh);
  const words: number[] = [];
  let acc = 0, bits = 0;
  for (const b of payload) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) words.push((acc >> (bits -= 5)) & 31);
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const mod = polymod([...Array.from(prefix, (ch) => ch.charCodeAt(0) & 31), 0, ...words, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum = Array.from({ length: 8 }, (_, i) => Number((mod >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** Electrum scripthash: sha256 of the locking script, reversed, hex. */
export function scripthash(script: Uint8Array): string {
  return Array.from(sha256(script).reverse(), (x) => x.toString(16).padStart(2, "0")).join("");
}
