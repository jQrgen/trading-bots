import { connect } from "cloudflare:sockets";

/*
 * Tiny Electrum (Fulcrum) client over TLS, for the wallet's UTXOs. Fulcrum returns CashToken data (token_data) with each UTXO by default.
 * Several public servers are tried in turn; ELECTRUM_SERVERS can override them ("host:port,host:port").
 */

export const DEFAULT_SERVERS = ["bch.imaginary.cash:50002", "electroncash.de:50002", "bch.loping.net:50002", "electrum.imaginary.cash:50002"];

export interface Utxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
  token_data?: { category: string; amount: string; nft?: { capability: string; commitment: string } };
}

async function call(server: string, method: string, params: unknown[]): Promise<unknown> {
  // "tcp://host:port" is plain TCP, for a local mock server; everything else is TLS.
  const plain = server.startsWith("tcp://");
  const [hostname, port] = server.replace(/^\w+:\/\//, "").split(":");
  const socket = connect({ hostname, port: Number(port) || 50002 }, { secureTransport: plain ? "off" : "on", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`electrum ${hostname}: timeout`)), 10_000));
  try {
    const enc = new TextEncoder();
    await writer.write(enc.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server.version", params: ["cauldron-desk", ["1.4", "1.5.3"]] }) + "\n"));
    await writer.write(enc.encode(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n"));
    const read = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`electrum ${hostname}: closed`);
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (msg.id !== 2) continue;
          if (msg.error) throw new Error(`electrum ${hostname}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
          return msg.result;
        }
      }
    })();
    return await Promise.race([read, timer]);
  } finally {
    socket.close().catch(() => {});
  }
}

export async function electrum(servers: string[], method: string, params: unknown[]): Promise<unknown> {
  const errors: string[] = [];
  for (const s of servers) {
    try {
      return await call(s, method, params);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  throw new Error(`no Electrum server answered: ${errors.join("; ")}`);
}

export const listUnspent = (servers: string[], scripthash: string) =>
  electrum(servers, "blockchain.scripthash.listunspent", [scripthash]) as Promise<Utxo[]>;
