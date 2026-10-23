// Tiny stand-in for the Riften indexer, for running the Worker locally:
//   node test/mock/indexer.mjs &
//   echo 'INDEXER_URL="http://127.0.0.1:8788/cauldron"' >> .dev.vars
// The router is left unreachable, which exercises the estimate fallback.
// For a fake Grok too, add XAI_API_KEY="x" and XAI_BASE_URL="http://127.0.0.1:8788/xai" to .dev.vars.
import http from "node:http";

const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const now = Math.floor(Date.now() / 1000);
let tick = 0;
const tokens = () => {
  tick++;
  const wob = 1 + Math.sin(tick / 2) * 0.15 + tick * 0.03;
  return [
    { token_id: PUSD, display_symbol: "PUSD", bcmr: { token: { decimals: 2 } }, tvl_sats: 45e9, tvl_tokens: 12813548, price_now: 352232, price_now_usd: 1, change_24h_bp: 0, first_pool_ts: now - 200 * 86400, score_rank: 1 },
    { token_id: "f".repeat(64), display_symbol: "MOON", bcmr: { token: { decimals: 0 } }, tvl_sats: 30e8, tvl_tokens: 5e8, trade_volume: 300e8, price_now: 4 * wob, price_now_usd: 0.00001, change_24h_bp: 1200, first_pool_ts: now - 3 * 86400, score_rank: 2 },
    { token_id: "e".repeat(64), display_symbol: "RUG", bcmr: { token: { decimals: 0 } }, tvl_sats: 8e8, tvl_tokens: 1e8, price_now: 8, change_24h_bp: 4000, first_pool_ts: now - 3600, score_rank: 3 },
  ];
};
// Fake xAI: answers each agent with plausible JSON so the whole Grok path can be exercised.
function grok(body) {
  const msgs = body.messages ?? body.input;
  const sys = msgs[0].content;
  const input = JSON.parse(msgs[1].content.split("INPUT:\n")[1].split("\n\nUse X search")[0]);
  const reply = sys.includes("# Orin")
    ? { signals: input.tokens.slice(0, 2).map((t) => ({ token_id: t.token_id, symbol: t.symbol, signal: "liquidity-growth", why: "Liquidity growing with price." })), note: "Quiet market." }
    : sys.includes("# Vela")
      ? { proposals: input.research.map((r) => ({ action: "buy", token_id: r.token_id, symbol: r.symbol, horizon: "short", size_pct: 2, target_pct: 20, stop_pct: 10, bull_case: "Growing pool.", bear_case: "Thin market.", thesis: "Small momentum bet." })), note: "Two ideas." }
      : sys.includes("# Kade")
        ? { verdicts: input.proposals.map((p) => ({ proposal_id: p.id, veto: false, comment: "Fine at this size." })) }
        : sys.includes("# Nova")
          ? { decisions: input.proposals.map((p) => ({ proposal_id: p.id, approve: true, reason: "Fits the degen book." })), note: "Go." }
          : { journal: "Quiet day.", lessons: ["Prefer pools with several LPs."], strategy_suggestion: "" };
  const text = JSON.stringify(reply);
  return body.messages ? { choices: [{ message: { content: text } }] } : { output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname.startsWith("/xai/")) {
    let raw = "";
    for await (const c of req) raw += c;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(grok(JSON.parse(raw))));
  }
  let body = [];
  if (u.pathname.endsWith("/tokens/list_cached") || u.pathname.endsWith("/tokens/list_cached_by_ids")) body = tokens();
  else if (u.pathname.endsWith("/pool/active")) body = u.searchParams.get("token") === "e".repeat(64) ? [{ owner_pkh: "a", sats: 8e8, token_amount: 1 }] : [{ owner_pkh: "a", sats: 5e8, token_amount: 1 }, { owner_pkh: "b", sats: 5e8, token_amount: 1 }];
  else if (u.pathname.includes("/candlesticks")) body = [1, 2, 3].map((i) => ({ open: 3, high: 5, low: 3, close: 3 + i * 0.3 }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(8788, () => console.log("mock indexer on :8788"));
